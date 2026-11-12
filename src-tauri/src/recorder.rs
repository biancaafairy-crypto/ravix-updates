use crate::audio::{current_qpc, qpc_elapsed_100ns, AudioCaptureHandle, AudioChunk};
use crate::capabilities::get_free_disk_bytes;
use crate::config::build_unique_recording_path;
use crate::d3d11::{CapStagingReader, D3D11Context, EncBgraUploader, GpuBgraToNv12, SharedBgraSlot};
use crate::geometry::compute_target_dimensions;
use crate::models::{RecorderStatus, RecordingConfig};
use crate::sink::MediaSinkWriter;
use crate::wgc::WgcSession;
use crossbeam_channel::{bounded, select, Receiver, Sender};
use parking_lot::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject,
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE,
};

struct SendD3D11Context(D3D11Context);
unsafe impl Send for SendD3D11Context {}

struct VideoFrameMsg {
    slot: SharedBgraSlot,
    timestamp_100ns: i64,
    duration_100ns: i64,
}

struct ActiveRun {
    stop_flag: Arc<AtomicBool>,
    worker_handle: Option<JoinHandle<()>>,
}

pub struct RecorderManager {
    status: Arc<RwLock<RecorderStatus>>,
    active: Arc<parking_lot::Mutex<Option<ActiveRun>>>,
    on_state_change: Arc<dyn Fn(&str) + Send + Sync>,
}

impl RecorderManager {
    pub fn new<F>(on_state_change: F) -> Self
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        Self {
            status: Arc::new(RwLock::new(RecorderStatus::default())),
            active: Arc::new(parking_lot::Mutex::new(None)),
            on_state_change: Arc::new(on_state_change),
        }
    }

    pub fn get_status(&self) -> RecorderStatus {
        self.status.read().clone()
    }

    pub fn is_recording(&self) -> bool {
        let st = self.status.read();
        st.state == "recording" || st.state == "starting"
    }

    pub fn start(&self, config: RecordingConfig, app: AppHandle, encoder_name: String) -> Result<(), String> {
        let mut active_guard = self.active.lock();
        if active_guard.is_some() {
            return Err("Já existe uma gravação em andamento.".to_string());
        }

        if config.source_id.trim().is_empty() {
            return Err("Selecione uma janela ou monitor para capturar.".to_string());
        }

        // Checar espaço livre antes de iniciar
        if let Some(free_bytes) = get_free_disk_bytes(&config.output_dir) {
            let free_mb = free_bytes / (1024 * 1024);
            if free_mb < config.min_free_disk_mb {
                return Err(format!(
                    "Espaço insuficiente no disco ({free_mb} MB livres; mínimo seguro: {} MB).",
                    config.min_free_disk_mb
                ));
            }
        }

        {
            let mut st = self.status.write();
            *st = RecorderStatus {
                state: "starting".to_string(),
                target_fps: config.fps,
                duration_limit_secs: config.duration_limit_secs,
                active_encoder_name: Some(encoder_name.clone()),
                framing_mode: config.framing_mode.clone(),
                ..Default::default()
            };
        }
        (self.on_state_change)("starting");
        let _ = app.emit("recorder-status", self.get_status());

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = stop_flag.clone();
        let status_arc = self.status.clone();
        let on_state = self.on_state_change.clone();
        let active_ref = self.active.clone();

        let (startup_tx, startup_rx) = bounded::<Result<(), String>>(1);

        let handle = thread::Builder::new()
            .name("ravix-coordinator".to_string())
            .spawn(move || {
                let res = run_recording_pipeline(
                    config,
                    encoder_name,
                    stop_clone,
                    status_arc.clone(),
                    on_state.clone(),
                    app.clone(),
                    startup_tx,
                );

                if let Err(err_msg) = res {
                    crate::logger::error("recorder", &format!("Pipeline encerrado com erro: {err_msg}"));
                    let mut st = status_arc.write();
                    st.state = "error".to_string();
                    st.last_error = Some(err_msg);
                    drop(st);
                    (on_state)("error");
                    let _ = app.emit("recorder-status", status_arc.read().clone());
                } else {
                    let st_snap = status_arc.read().clone();
                    crate::logger::info(
                        "recorder",
                        &format!(
                            "Gravação finalizada com segurança: frames_written={}, dropped={}, actual_fps={:.1}",
                            st_snap.frames_written, st_snap.frames_dropped, st_snap.actual_fps
                        ),
                    );
                    let mut st = status_arc.write();
                    st.state = "idle".to_string();
                    drop(st);
                    (on_state)("idle");
                    let _ = app.emit("recorder-status", status_arc.read().clone());
                }

                // Limpar referência ativa caso tenha parado por limite de tempo/disco/erro
                if let Some(mut guard) = active_ref.try_lock() {
                    *guard = None;
                }
            })
            .map_err(|e| format!("Falha ao criar thread do gravador: {e}"))?;

        match startup_rx.recv() {
            Ok(Ok(())) => {
                *active_guard = Some(ActiveRun {
                    stop_flag,
                    worker_handle: Some(handle),
                });
                Ok(())
            }
            Ok(Err(err)) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = handle.join();
                {
                    let mut st = self.status.write();
                    st.state = "error".to_string();
                    st.last_error = Some(err.clone());
                }
                (self.on_state_change)("error");
                Err(err)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err("Falha inesperada ao inicializar pipeline de gravação.".to_string())
            }
        }
    }

    pub fn stop(&self) {
        let run_opt = {
            let mut guard = self.active.lock();
            guard.take()
        };
        if let Some(mut run) = run_opt {
            {
                let mut st = self.status.write();
                if st.state == "recording" || st.state == "starting" {
                    st.state = "stopping".to_string();
                }
            }
            (self.on_state_change)("stopping");
            run.stop_flag.store(true, Ordering::SeqCst);
            if let Some(h) = run.worker_handle.take() {
                let _ = h.join();
            }
        }
    }
}

fn run_recording_pipeline(
    config: RecordingConfig,
    _encoder_name: String,
    stop_flag: Arc<AtomicBool>,
    status_arc: Arc<RwLock<RecorderStatus>>,
    on_state: Arc<dyn Fn(&str) + Send + Sync>,
    app: AppHandle,
    startup_tx: Sender<Result<(), String>>,
) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, 0).map_err(|e| format!("Falha MFStartup: {e}"))?;
    }

    struct MfGuard;
    impl Drop for MfGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }
    let _mf_guard = MfGuard;

    let cap_d3d = match D3D11Context::new() {
        Ok(c) => c,
        Err(e) => {
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    // Device isolado para o encoder evita deadlock entre callbacks do WGC e MFTs de hardware (AMD/NVIDIA)
    let enc_d3d = match D3D11Context::new() {
        Ok(c) => c,
        Err(e) => {
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let mut wgc = match WgcSession::start(
        cap_d3d.device.clone(),
        cap_d3d.context.clone(),
        &cap_d3d.winrt_device,
        &config.source_kind,
        &config.source_id,
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let (out_w, out_h) = compute_target_dimensions(
        wgc.initial_width,
        wgc.initial_height,
        &config.resolution_mode,
        config.custom_width,
        config.custom_height,
    );

    // Pool limitado de 4 buffers BGRA recicláveis (isolamento total entre cap_d3d e enc_d3d)
    let (free_tx, free_rx): (Sender<SharedBgraSlot>, Receiver<SharedBgraSlot>) = bounded(4);
    for _ in 0..4 {
        let _ = free_tx.send(SharedBgraSlot::new(wgc.initial_width, wgc.initial_height));
    }

    let mut cap_reader = match CapStagingReader::new(
        cap_d3d.device.clone(),
        cap_d3d.context.clone(),
        wgc.initial_width,
        wgc.initial_height,
    ) {
        Ok(r) => r,
        Err(e) => {
            wgc.stop();
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let first_path = match build_unique_recording_path(&config.output_dir, 1) {
        Ok(p) => p,
        Err(e) => {
            wgc.stop();
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let has_audio = config.system_audio_enabled || config.mic_enabled;
    let prefer_hardware = !config.encoder_id.starts_with("sw:");
    let (t0_qpc, qpc_freq) = current_qpc();

    // Filas assíncronas limitadas
    let (video_tx, video_rx): (Sender<VideoFrameMsg>, Receiver<VideoFrameMsg>) = bounded(4);
    let (audio_tx, audio_rx): (Sender<AudioChunk>, Receiver<AudioChunk>) = bounded(64);

    let frames_captured = Arc::new(AtomicU64::new(0));
    let frames_written = Arc::new(AtomicU64::new(0));
    let frames_dropped = Arc::new(AtomicU64::new(0));
    let encoder_errors = Arc::new(AtomicU64::new(0));
    let fatal_error: Arc<parking_lot::Mutex<Option<String>>> =
        Arc::new(parking_lot::Mutex::new(None));

    // Toda operação no enc_d3d (EncBgraUploader + GpuBgraToNv12 + MediaSinkWriter) roda exclusivamente na thread ravix-muxer
    let stop_mux = stop_flag.clone();
    let fw_mux = frames_written.clone();
    let fd_mux = frames_dropped.clone();
    let ee_mux = encoder_errors.clone();
    let fatal_mux = fatal_error.clone();
    let status_mux = status_arc.clone();
    let cfg_mux = config.clone();
    let free_tx_mux = free_tx.clone();
    let init_w = wgc.initial_width;
    let init_h = wgc.initial_height;
    let enc_d3d_send = SendD3D11Context(enc_d3d);
    let first_path_mux = first_path.clone();
    let (mux_init_tx, mux_init_rx) = bounded::<Result<(), String>>(1);

    let muxer_handle = thread::Builder::new()
        .name("ravix-muxer".to_string())
        .spawn(move || {
            let enc_d3d_send = enc_d3d_send;
            let enc_d3d = enc_d3d_send.0;
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }

            let mut uploader = match EncBgraUploader::new(
                enc_d3d.device.clone(),
                enc_d3d.context.clone(),
                init_w,
                init_h,
            ) {
                Ok(u) => u,
                Err(e) => {
                    let _ = mux_init_tx.send(Err(e));
                    unsafe { CoUninitialize(); }
                    return;
                }
            };

            let mut converter = match GpuBgraToNv12::new(
                enc_d3d.device.clone(),
                enc_d3d.context.clone(),
                init_w,
                init_h,
                out_w,
                out_h,
                &cfg_mux.framing_mode,
            ) {
                Ok(c) => c,
                Err(e) => {
                    let _ = mux_init_tx.send(Err(e));
                    unsafe { CoUninitialize(); }
                    return;
                }
            };

            let (nv12_tex, nv12_view) = match converter.create_nv12_texture() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = mux_init_tx.send(Err(e));
                    unsafe { CoUninitialize(); }
                    return;
                }
            };

            let sink = match MediaSinkWriter::create(
                &first_path_mux,
                &enc_d3d.mf_dxgi_manager,
                out_w,
                out_h,
                cfg_mux.fps,
                cfg_mux.bitrate_kbps,
                has_audio,
                prefer_hardware,
            ) {
                Ok(s) => s,
                Err(e) => {
                    if prefer_hardware {
                        match MediaSinkWriter::create(
                            &first_path_mux,
                            &enc_d3d.mf_dxgi_manager,
                            out_w,
                            out_h,
                            cfg_mux.fps,
                            cfg_mux.bitrate_kbps,
                            has_audio,
                            false,
                        ) {
                            Ok(sw_s) => sw_s,
                            Err(e2) => {
                                let _ = mux_init_tx.send(Err(format!(
                                    "Falha ao inicializar encoder (HW: {e} | SW: {e2})"
                                )));
                                unsafe { CoUninitialize(); }
                                return;
                            }
                        }
                    } else {
                        let _ = mux_init_tx.send(Err(e));
                        unsafe { CoUninitialize(); }
                        return;
                    }
                }
            };

            let _ = mux_init_tx.send(Ok(()));

            let mut active_sink = Some(sink);
            let mut segment_idx: u32 = 1;
            let mut segment_start_100ns: i64 = 0;
            let segment_limit_100ns = cfg_mux
                .segment_minutes
                .filter(|&m| m > 0)
                .map(|m| (m as i64) * 60 * 10_000_000);

            loop {
                select! {
                    recv(video_rx) -> msg => {
                        match msg {
                            Ok(v) => {
                                if let Some(limit) = segment_limit_100ns {
                                    if v.timestamp_100ns - segment_start_100ns >= limit {
                                        if let Some(old) = active_sink.take() {
                                            let _ = old.finalize();
                                        }
                                        segment_idx += 1;
                                        segment_start_100ns = v.timestamp_100ns;
                                        match build_unique_recording_path(&cfg_mux.output_dir, segment_idx) {
                                            Ok(next_path) => {
                                                match MediaSinkWriter::create(
                                                    &next_path,
                                                    &enc_d3d.mf_dxgi_manager,
                                                    out_w,
                                                    out_h,
                                                    cfg_mux.fps,
                                                    cfg_mux.bitrate_kbps,
                                                    has_audio,
                                                    prefer_hardware,
                                                ) {
                                                    Ok(new_sink) => {
                                                        let mut st = status_mux.write();
                                                        st.current_file = Some(next_path.to_string_lossy().to_string());
                                                        st.current_segment = segment_idx;
                                                        active_sink = Some(new_sink);
                                                    }
                                                    Err(e) => {
                                                        ee_mux.fetch_add(1, Ordering::Relaxed);
                                                        *fatal_mux.lock() = Some(format!("Erro ao abrir próximo segmento: {e}"));
                                                        stop_mux.store(true, Ordering::SeqCst);
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                *fatal_mux.lock() = Some(e);
                                                stop_mux.store(true, Ordering::SeqCst);
                                            }
                                        }
                                    }
                                }

                                let mut conv_res = uploader
                                    .upload(&v.slot)
                                    .and_then(|enc_tex| converter.convert_bgra_to_nv12(enc_tex, &nv12_view));
                                if let Some(ref s) = active_sink {
                                    let rel_ts = (v.timestamp_100ns - segment_start_100ns).max(0);
                                    conv_res = conv_res.and_then(|()| {
                                        s.write_video_texture(&nv12_tex, rel_ts, v.duration_100ns)
                                    });
                                    match conv_res {
                                        Ok(()) => {
                                            fw_mux.fetch_add(1, Ordering::Relaxed);
                                        }
                                        Err(e) => {
                                            ee_mux.fetch_add(1, Ordering::Relaxed);
                                            fd_mux.fetch_add(1, Ordering::Relaxed);
                                            if ee_mux.load(Ordering::Relaxed) >= 30 {
                                                *fatal_mux.lock() = Some(format!("Falhas consecutivas no encoder de vídeo: {e}"));
                                                stop_mux.store(true, Ordering::SeqCst);
                                            }
                                        }
                                    }
                                }
                                let _ = free_tx_mux.send(v.slot);
                            }
                            Err(_) => break,
                        }
                    }
                    recv(audio_rx) -> msg => {
                        match msg {
                            Ok(a) => {
                                if let Some(ref s) = active_sink {
                                    let rel_ts = (a.timestamp_100ns - segment_start_100ns).max(0);
                                    if a.timestamp_100ns >= segment_start_100ns {
                                        if s.write_audio_pcm(&a.data, rel_ts, a.duration_100ns).is_err() {
                                            ee_mux.fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            }
                            Err(_) => {
                                if video_rx.is_empty() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if let Some(s) = active_sink.take() {
                if let Err(e) = s.finalize() {
                    *fatal_mux.lock() = Some(e);
                }
            }
            unsafe {
                CoUninitialize();
            }
        })
        .map_err(|e| format!("Falha ao iniciar thread muxer: {e}"))?;

    match mux_init_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            wgc.stop();
            drop(video_tx);
            drop(audio_tx);
            let _ = muxer_handle.join();
            let _ = startup_tx.send(Err(e.clone()));
            return Err(e);
        }
        Err(_) => {
            wgc.stop();
            drop(video_tx);
            drop(audio_tx);
            let _ = muxer_handle.join();
            let err = "Thread do muxer encerrou durante a inicialização.".to_string();
            let _ = startup_tx.send(Err(err.clone()));
            return Err(err);
        }
    }

    let audio_handle = if has_audio {
        match AudioCaptureHandle::start(
            config.system_audio_enabled,
            config.system_audio_device_id.clone(),
            config.mic_enabled,
            config.mic_device_id.clone(),
            t0_qpc,
            qpc_freq,
            audio_tx,
        ) {
            Ok(h) => Some(h),
            Err(e) => {
                wgc.stop();
                drop(video_tx);
                let _ = muxer_handle.join();
                let _ = startup_tx.send(Err(e.clone()));
                return Err(e);
            }
        }
    } else {
        drop(audio_tx);
        None
    };

    {
        let mut st = status_arc.write();
        st.state = "recording".to_string();
        st.current_file = Some(first_path.to_string_lossy().to_string());
        st.current_segment = 1;
        st.last_error = None;
        st.source_width = wgc.initial_width;
        st.source_height = wgc.initial_height;
        st.output_width = out_w;
        st.output_height = out_h;
        st.framing_mode = config.framing_mode.clone();
    }
    (on_state)("recording");
    let _ = app.emit("recorder-status", status_arc.read().clone());
    let _ = startup_tx.send(Ok(()));

    // Thread de telemetria e watchdog de disco / duração
    let stop_mon = stop_flag.clone();
    let status_mon = status_arc.clone();
    let app_mon = app.clone();
    let fc_mon = frames_captured.clone();
    let fw_mon = frames_written.clone();
    let fd_mon = frames_dropped.clone();
    let ee_mon = encoder_errors.clone();
    let fatal_mon = fatal_error.clone();
    let out_dir_mon = config.output_dir.clone();
    let min_disk_mb = config.min_free_disk_mb;
    let duration_limit = config.duration_limit_secs;
    let target_fps = config.fps;

    let monitor_handle = thread::Builder::new()
        .name("ravix-monitor".to_string())
        .spawn(move || {
            let start_instant = Instant::now();
            let mut sys = System::new();
            let self_pid = Pid::from_u32(std::process::id());
            let mut last_written = 0u64;
            let mut last_tick = Instant::now();
            let mut smoothed_fps = target_fps as f64;
            let mut disk_check_counter = 0u32;
            let mut last_free_gb = 0.0f64;

            while !stop_mon.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(250));

                let elapsed = start_instant.elapsed().as_secs_f64();
                if let Some(limit) = duration_limit {
                    if elapsed >= limit as f64 {
                        stop_mon.store(true, Ordering::SeqCst);
                    }
                }

                disk_check_counter += 1;
                if disk_check_counter % 8 == 1 {
                    if let Some(free_bytes) = get_free_disk_bytes(&out_dir_mon) {
                        last_free_gb = free_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
                        let free_mb = free_bytes / (1024 * 1024);
                        if free_mb < min_disk_mb {
                            *fatal_mon.lock() = Some(format!(
                                "Gravação interrompida para proteger o armazenamento ({free_mb} MB livres < {min_disk_mb} MB)."
                            ));
                            stop_mon.store(true, Ordering::SeqCst);
                        }
                    }
                }

                sys.refresh_processes(ProcessesToUpdate::Some(&[self_pid]), true);
                let (cpu_pct, mem_mb) = sys
                    .process(self_pid)
                    .map(|p| (p.cpu_usage(), p.memory() as f64 / (1024.0 * 1024.0)))
                    .unwrap_or((0.0, 0.0));

                let now = Instant::now();
                let dt = now.duration_since(last_tick).as_secs_f64().max(0.05);
                let cur_written = fw_mux_read(&fw_mon);
                let inst_fps = (cur_written.saturating_sub(last_written)) as f64 / dt;
                smoothed_fps = smoothed_fps * 0.65 + inst_fps * 0.35;
                last_written = cur_written;
                last_tick = now;

                let fps_warning = if elapsed > 3.0 && smoothed_fps < (target_fps as f64 * 0.85) {
                    Some(format!(
                        "Taxa efetiva ({:.1} FPS) abaixo do alvo ({target_fps} FPS). Reduza resolução ou bitrate.",
                        smoothed_fps
                    ))
                } else {
                    None
                };

                {
                    let mut st = status_mon.write();
                    st.elapsed_secs = elapsed;
                    st.frames_captured = fc_mon.load(Ordering::Relaxed);
                    st.frames_written = cur_written;
                    st.frames_dropped = fd_mon.load(Ordering::Relaxed);
                    st.encoder_errors = ee_mon.load(Ordering::Relaxed);
                    st.actual_fps = (smoothed_fps * 10.0).round() / 10.0;
                    st.fps_warning = fps_warning;
                    st.cpu_usage_pct = (cpu_pct * 10.0).round() / 10.0;
                    st.memory_mb = (mem_mb * 10.0).round() / 10.0;
                    st.free_disk_gb = (last_free_gb * 100.0).round() / 100.0;
                }
                let _ = app_mon.emit("recorder-status", status_mon.read().clone());
            }
        })
        .map_err(|e| format!("Falha ao iniciar thread de monitoramento: {e}"))?;

    // Loop de frame pacing CFR usando Waitable Timer de Alta Resolução
    let frame_duration_100ns = 10_000_000i64 / (config.fps.max(1) as i64);
    let timer_handle = create_high_res_timer();

    let mut next_frame_100ns: i64 = 0;

    // Aguardar até 500ms pelo primeiro frame real do WGC antes do loop principal
    let wait_start = Instant::now();
    while wgc.slot.sequence.load(Ordering::Acquire) == 0
        && wait_start.elapsed() < Duration::from_millis(500)
        && !stop_flag.load(Ordering::Relaxed)
    {
        thread::sleep(Duration::from_millis(5));
    }

    while !stop_flag.load(Ordering::Relaxed) {
        if wgc.slot.item_closed.load(Ordering::Acquire) {
            *fatal_error.lock() = Some("A janela capturada foi fechada. Gravação finalizada com segurança.".to_string());
            stop_flag.store(true, Ordering::SeqCst);
            break;
        }

        let now_100ns = qpc_elapsed_100ns(t0_qpc, qpc_freq);
        if now_100ns < next_frame_100ns {
            let wait_100ns = next_frame_100ns - now_100ns;
            if let Some(h) = timer_handle {
                wait_high_res_timer(h, wait_100ns);
            } else {
                let ms = (wait_100ns / 10_000).max(1) as u64;
                thread::sleep(Duration::from_millis(ms));
            }
            continue;
        }

        // Capturar slot livre; WGC copia na thread coordenadora (sem contenção com FrameArrived)
        let tex_opt = wgc.acquire_latest_texture();
        if let Some((bgra_tex, _, _, _)) = tex_opt {
            frames_captured.fetch_add(1, Ordering::Relaxed);
            match free_rx.try_recv() {
                Ok(mut slot) => {
                    let copied = cap_reader.read_frame(&bgra_tex, &mut slot);
                    if copied.is_ok() {
                        if video_tx
                            .try_send(VideoFrameMsg {
                                slot,
                                timestamp_100ns: next_frame_100ns,
                                duration_100ns: frame_duration_100ns,
                            })
                            .is_err()
                        {
                            frames_dropped.fetch_add(1, Ordering::Relaxed);
                        }
                    } else {
                        let _ = free_tx.send(slot);
                        frames_dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(_) => {
                    // Pool esgotado porque a GPU/encoder não conseguiu esvaziar a tempo
                    frames_dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        next_frame_100ns += frame_duration_100ns;
        // Se houve atraso severo (> 3 frames), resincronizar para não gerar rajadas
        let post_100ns = qpc_elapsed_100ns(t0_qpc, qpc_freq);
        if post_100ns - next_frame_100ns > frame_duration_100ns * 3 {
            next_frame_100ns = post_100ns;
        }
    }

    if let Some(h) = timer_handle {
        unsafe {
            let _ = CloseHandle(h);
        }
    }

    // Encerramento limpo em ordem: parar entrada WGC e áudio, fechar canais, aguardar muxer finalizar o MP4 fragmentado
    wgc.stop();
    if let Some(ah) = audio_handle {
        ah.stop();
    }
    drop(video_tx);
    let _ = muxer_handle.join();
    let _ = monitor_handle.join();

    if let Some(err) = fatal_error.lock().take() {
        return Err(err);
    }

    Ok(())
}

fn fw_mux_read(a: &AtomicU64) -> u64 {
    a.load(Ordering::Relaxed)
}

fn create_high_res_timer() -> Option<HANDLE> {
    unsafe {
        CreateWaitableTimerExW(
            None,
            None,
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
            0x001F0003, // TIMER_ALL_ACCESS
        )
        .ok()
    }
}

fn wait_high_res_timer(timer: HANDLE, duration_100ns: i64) {
    unsafe {
        // Tempo relativo negativo em unidades de 100ns
        let due_time = -(duration_100ns.max(10_000));
        if SetWaitableTimer(timer, &due_time, 0, None, None, false).is_ok() {
            let _ = WaitForSingleObject(timer, INFINITE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::collect_capabilities;
    use crate::d3d11::SharedGpuBridge;
    use crate::wgc::compute_output_dimensions;

    #[test]
    fn dimensions_are_always_even_without_upscale() {
        assert_eq!(compute_output_dimensions(1920, 1080, "native"), (1920, 1080));
        assert_eq!(compute_output_dimensions(1441, 901, "native"), (1440, 900));
        assert_eq!(compute_output_dimensions(2560, 1440, "1080p"), (1920, 1080));
        assert_eq!(compute_output_dimensions(1440, 900, "1080p"), (1440, 900));
        assert_eq!(compute_output_dimensions(1920, 1080, "720p"), (1280, 720));
    }

    #[test]
    fn unique_recording_path_never_overwrites() {
        let dir = std::env::temp_dir().join("ravix_unit_paths");
        let _ = std::fs::remove_dir_all(&dir);
        let p1 = build_unique_recording_path(&dir.to_string_lossy(), 1).unwrap();
        std::fs::write(&p1, b"test").unwrap();
        let p2 = build_unique_recording_path(&dir.to_string_lossy(), 1).unwrap();
        assert_ne!(p1, p2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "Grava a tela real por 2s; execute explicitamente com --ignored para validar hardware"]
    fn real_windows_capture_and_hardware_encode_smoke() {
        thread::spawn(|| {
            thread::sleep(Duration::from_secs(12));
            std::process::exit(99);
        });

        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, 0).expect("MFStartup failed");
        }

        let tmp_dir = std::env::temp_dir().join("ravix_smoke");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let caps = collect_capabilities(tmp_dir.to_string_lossy().to_string());
        assert!(!caps.sources.is_empty());
        assert!(!caps.encoders.is_empty());

        let mon = caps.sources.iter().find(|s| s.kind == "monitor").unwrap();

        let d3d = D3D11Context::new().expect("D3D11Context failed");
        let enc_d3d = D3D11Context::new().expect("Encoder D3D11Context failed");
        let mut wgc = WgcSession::start(
            d3d.device.clone(),
            d3d.context.clone(),
            &d3d.winrt_device,
            &mon.kind,
            &mon.id,
        )
        .expect("WgcSession failed");

        let (out_w, out_h) =
            compute_output_dimensions(wgc.initial_width, wgc.initial_height, "1080p");
        let mut bridge = SharedGpuBridge::new(
            d3d.device.clone(),
            d3d.context.clone(),
            enc_d3d.device.clone(),
            wgc.initial_width,
            wgc.initial_height,
        )
        .expect("SharedGpuBridge failed");
        let mut conv = GpuBgraToNv12::new(
            enc_d3d.device.clone(),
            enc_d3d.context.clone(),
            wgc.initial_width,
            wgc.initial_height,
            out_w,
            out_h,
            "stretch",
        )
        .expect("GpuBgraToNv12 failed");

        let out_file = tmp_dir.join("smoke_test.mp4");
        let _ = std::fs::remove_file(&out_file);

        let sink = MediaSinkWriter::create(
            &out_file,
            &enc_d3d.mf_dxgi_manager,
            out_w,
            out_h,
            60,
            25000,
            true,
            true,
        )
        .expect("MediaSinkWriter failed");

        let (t0_qpc, qpc_freq) = current_qpc();
        let (audio_tx, audio_rx) = bounded::<AudioChunk>(64);
        let audio = AudioCaptureHandle::start(true, None, false, None, t0_qpc, qpc_freq, audio_tx)
            .expect("AudioCaptureHandle failed");

        let (tex, view) = conv.create_nv12_texture().expect("create_nv12_texture failed");
        let wait_start = Instant::now();
        while wgc.slot.sequence.load(Ordering::Acquire) == 0
            && wait_start.elapsed() < Duration::from_millis(1000)
        {
            thread::sleep(Duration::from_millis(10));
        }

        let mut written_video = 0u64;
        let frame_dur = 10_000_000i64 / 60;
        for i in 0..120i64 {
            let target_ts = i * frame_dur;
            while qpc_elapsed_100ns(t0_qpc, qpc_freq) < target_ts {
                thread::sleep(Duration::from_millis(2));
            }
            if let Some((bgra, _, _, _)) = wgc.acquire_latest_texture() {
                let enc_bgra = bridge.transfer(&bgra).expect("bridge.transfer failed");
                conv.convert_bgra_to_nv12(enc_bgra, &view)
                    .expect("convert_bgra_to_nv12 failed");
                sink.write_video_texture(&tex, target_ts, frame_dur)
                    .expect("write_video_texture failed");
                written_video += 1;
            }
            while let Ok(a) = audio_rx.try_recv() {
                sink.write_audio_pcm(&a.data, a.timestamp_100ns, a.duration_100ns)
                    .expect("write_audio_pcm failed");
            }
        }

        wgc.stop();
        audio.stop();
        while let Ok(a) = audio_rx.try_recv() {
            let _ = sink.write_audio_pcm(&a.data, a.timestamp_100ns, a.duration_100ns);
        }
        sink.finalize().expect("sink finalize failed");

        let meta = std::fs::metadata(&out_file).expect("Arquivo final não existe");
        assert!(meta.len() > 50_000);
        assert!(written_video >= 80);
        let _ = std::fs::remove_dir_all(&tmp_dir);

        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
