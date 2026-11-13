use crate::d3d11::{D3D11Context, EncBgraUploader, GpuBgraToNv12, SharedBgraSlot};
use crate::geometry::compute_target_dimensions;
use crate::logger;
use crate::models::{
    ExportConfig, ExportProgress, MediaAssetInfo, TimelineExportConfig, VideoMetadata,
};
use crate::sink::MediaSinkWriter;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::{
    MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL,
    IMFSourceReader,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFVideoFormat_H264, MFVideoFormat_RGB32,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_PD_DURATION,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE,
    MF_SOURCE_READER_ANY_STREAM,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
    MFMediaType_Audio, MFMediaType_Video,
    MFShutdown, MFStartup, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToInt64;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

static EXPORT_CANCEL_FLAG: parking_lot::RwLock<Option<Arc<AtomicBool>>> =
    parking_lot::RwLock::new(None);

pub fn cancel_current_export() {
    if let Some(flag) = EXPORT_CANCEL_FLAG.read().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn get_video_metadata(path_str: &str) -> Result<VideoMetadata, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Err(format!("Arquivo não encontrado: {path_str}"));
    }
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("video.mp4")
        .to_string();
    let size_bytes = p.metadata().map(|m| m.len()).unwrap_or(0);

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

    unsafe {
        let hpath = HSTRING::from(path_str);
        let reader: IMFSourceReader = MFCreateSourceReaderFromURL(&hpath, None)
            .map_err(|e| format!("Falha ao abrir vídeo no Media Foundation: {e}"))?;

        // Duração total em 100ns
        let var_dur = reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .unwrap_or_default();
        let dur_100ns = PropVariantToInt64(&var_dur).unwrap_or(0);
        let duration_secs = (dur_100ns as f64) / 10_000_000.0;

        // Propriedades de Vídeo
        let mut width = 0u32;
        let mut height = 0u32;
        let mut fps = 60.0f64;
        let mut video_codec = "Desconhecido".to_string();
        let mut bitrate_kbps = 0u32;

        if let Ok(video_mt) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32) {
            if let Ok(val) = video_mt.GetUINT64(&MF_MT_FRAME_SIZE) {
                width = (val >> 32) as u32;
                height = (val & 0xFFFFFFFF) as u32;
            }

            if let Ok(val) = video_mt.GetUINT64(&MF_MT_FRAME_RATE) {
                let num = (val >> 32) as u32;
                let den = (val & 0xFFFFFFFF) as u32;
                if den > 0 {
                    fps = (num as f64) / (den as f64);
                    fps = (fps * 100.0).round() / 100.0;
                }
            }

            if let Ok(subtype) = video_mt.GetGUID(&MF_MT_SUBTYPE) {
                if subtype == MFVideoFormat_H264 {
                    video_codec = "H.264 / AVC".to_string();
                } else {
                    video_codec = format!("{:?}", subtype);
                }
            }

            if let Ok(bps) = video_mt.GetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND) {
                bitrate_kbps = bps * 8 / 1000;
            } else if duration_secs > 0.1 && size_bytes > 0 {
                bitrate_kbps = ((size_bytes as f64 * 8.0) / duration_secs / 1000.0) as u32;
            }
        }

        // Propriedades de Áudio
        let mut audio_codec = "Sem áudio".to_string();
        let mut audio_channels = 0u32;
        let mut audio_sample_rate = 0u32;

        if let Ok(audio_mt) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32) {
            if let Ok(ch) = audio_mt.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) {
                audio_channels = ch;
            }
            if let Ok(sr) = audio_mt.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) {
                audio_sample_rate = sr;
            }
            if let Ok(subtype) = audio_mt.GetGUID(&MF_MT_SUBTYPE) {
                if subtype == MFAudioFormat_AAC {
                    audio_codec = "AAC".to_string();
                } else if subtype == MFAudioFormat_PCM {
                    audio_codec = "PCM".to_string();
                } else {
                    audio_codec = format!("{:?}", subtype);
                }
            }
        }

        Ok(VideoMetadata {
            path: path_str.to_string(),
            filename,
            width,
            height,
            duration_secs,
            fps,
            bitrate_kbps,
            video_codec,
            audio_codec,
            audio_channels,
            audio_sample_rate,
            size_bytes,
        })
    }
}

pub fn run_export(config: ExportConfig, app: AppHandle) -> Result<(), String> {
    export_video_sync(config, move |p| {
        let _ = app.emit("export-progress", p);
    })
}

pub fn export_video_sync<F>(config: ExportConfig, on_progress: F) -> Result<(), String>
where
    F: Fn(ExportProgress),
{
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = EXPORT_CANCEL_FLAG.write();
        *guard = Some(cancel_flag.clone());
    }

    let meta = get_video_metadata(&config.input_path)?;
    if meta.width == 0 || meta.height == 0 {
        return Err("Vídeo de entrada inválido ou sem fluxo de vídeo decodificável.".to_string());
    }

    let (out_w, out_h) = compute_target_dimensions(
        meta.width,
        meta.height,
        &config.resolution_mode,
        config.custom_width,
        config.custom_height,
    );

    let target_fps = if config.fps > 0 { config.fps } else { (meta.fps.round() as u32).max(30) };
    let bitrate_kbps = if config.bitrate_kbps > 0 { config.bitrate_kbps } else { 25000 };

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

    let enc_d3d = D3D11Context::new().map_err(|e| format!("Falha D3D11 encoder: {e}"))?;

    let hpath = HSTRING::from(&config.input_path);
    let reader: IMFSourceReader = unsafe {
        // Criar atributos para habilitar processamento avançado de vídeo se necessário
        let mut attrs = None;
        let _ = MFCreateAttributes(&mut attrs, 2);
        if let Some(ref a) = attrs {
            let _ = a.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
        }
        MFCreateSourceReaderFromURL(&hpath, attrs.as_ref())
            .map_err(|e| format!("Falha ao abrir leitor de vídeo ({e})"))?
    };

    // Configurar leitor para decodificar vídeo como RGB32 (BGRA)
    unsafe {
        let video_out_mt = MFCreateMediaType().map_err(|e| format!("Falha MFCreateMediaType: {e}"))?;
        video_out_mt
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|e| format!("Falha SetGUID MFMediaType_Video: {e}"))?;
        video_out_mt
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
            .map_err(|e| format!("Falha SetGUID RGB32: {e}"))?;

        reader
            .SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &video_out_mt,
            )
            .map_err(|e| format!("Falha SetCurrentMediaType RGB32 leitor: {e}"))?;
    }

    // Configurar leitor para decodificar áudio como PCM estéreo 48kHz 16-bit
    let has_audio = meta.audio_channels > 0;
    if has_audio {
        unsafe {
            let audio_out_mt = MFCreateMediaType().map_err(|e| format!("Falha MFCreateMediaType áudio: {e}"))?;
            audio_out_mt
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                .map_err(|e| format!("Falha SetGUID MFMediaType_Audio: {e}"))?;
            audio_out_mt
                .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
                .map_err(|e| format!("Falha SetGUID PCM: {e}"))?;
            audio_out_mt
                .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
                .map_err(|e| format!("Falha SetUINT32 canais: {e}"))?;
            audio_out_mt
                .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000)
                .map_err(|e| format!("Falha SetUINT32 sample rate: {e}"))?;
            audio_out_mt
                .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                .map_err(|e| format!("Falha SetUINT32 bits: {e}"))?;
            audio_out_mt
                .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)
                .map_err(|e| format!("Falha SetUINT32 align: {e}"))?;
            audio_out_mt
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48000 * 4)
                .map_err(|e| format!("Falha SetUINT32 avg bytes: {e}"))?;

            let _ = reader.SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                None,
                &audio_out_mt,
            );
        }
    }

    // Pipeline D3D11 GPU para enquadramento e conversão BGRA -> NV12
    let mut uploader = EncBgraUploader::new(
        enc_d3d.device.clone(),
        enc_d3d.context.clone(),
        meta.width,
        meta.height,
    )?;

    let mut converter = GpuBgraToNv12::new(
        enc_d3d.device.clone(),
        enc_d3d.context.clone(),
        meta.width,
        meta.height,
        out_w,
        out_h,
        &config.framing_mode,
    )?;

    let (nv12_tex, nv12_view) = converter.create_nv12_texture()?;

    // Criar arquivo de saída destino
    let output_path = Path::new(&config.output_path);
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let sink = MediaSinkWriter::create(
        output_path,
        &enc_d3d.mf_dxgi_manager,
        out_w,
        out_h,
        target_fps,
        bitrate_kbps,
        has_audio,
        true, // prefer_hardware
    )?;

    // Identificar índices reais dos fluxos de vídeo e áudio
    let mut video_stream_idx = 0u32;
    let mut audio_stream_idx = 1u32;
    unsafe {
        for idx in 0..8 {
            if let Ok(mt) = reader.GetCurrentMediaType(idx) {
                if let Ok(major) = mt.GetGUID(&MF_MT_MAJOR_TYPE) {
                    if major == MFMediaType_Video {
                        video_stream_idx = idx;
                    } else if major == MFMediaType_Audio {
                        audio_stream_idx = idx;
                    }
                }
            }
        }
    }

    let mut slot = SharedBgraSlot::new(meta.width, meta.height);
    let total_dur_100ns = (meta.duration_secs * 10_000_000.0) as i64;
    let t_start = Instant::now();
    let mut frames_written = 0u64;
    let mut last_emit = Instant::now();

    let mut video_eof = false;
    let mut audio_eof = !has_audio;

    while !video_eof || (!audio_eof && has_audio) {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = sink.finalize();
            let _ = std::fs::remove_file(output_path);
            on_progress(ExportProgress {
                state: "cancelled".to_string(),
                progress_pct: 0.0,
                elapsed_secs: t_start.elapsed().as_secs_f64(),
                current_fps: 0.0,
                output_path: None,
                error: Some("Exportação cancelada pelo usuário.".to_string()),
            });
            return Ok(());
        }

        unsafe {
            // Ler próximo sample disponível
            let mut stream_index = 0u32;
            let mut stream_flags = 0u32;
            let mut timestamp_100ns = 0i64;
            let mut sample_opt = None;

            let hr = reader.ReadSample(
                MF_SOURCE_READER_ANY_STREAM.0 as u32,
                0,
                Some(&mut stream_index),
                Some(&mut stream_flags),
                Some(&mut timestamp_100ns),
                Some(&mut sample_opt),
            );

            if hr.is_err() {
                break;
            }

            if (stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                if stream_index == video_stream_idx {
                    video_eof = true;
                } else if stream_index == audio_stream_idx {
                    audio_eof = true;
                }
                if video_eof && (!has_audio || audio_eof) {
                    break;
                }
            }

            if let Some(sample) = sample_opt {
                let sample_dur_100ns = sample.GetSampleDuration().unwrap_or(10_000_000 / target_fps as i64);

                if stream_index == video_stream_idx {
                    if let Ok(buffer) = sample.ConvertToContiguousBuffer() {
                        let mut p_data = std::ptr::null_mut();
                        let mut max_len = 0u32;
                        let mut cur_len = 0u32;
                        if buffer.Lock(&mut p_data, Some(&mut max_len), Some(&mut cur_len)).is_ok() {
                            let expected = (slot.width as usize) * (slot.height as usize) * 4;
                            if (cur_len as usize) >= expected && !p_data.is_null() {
                                std::ptr::copy_nonoverlapping(p_data, slot.data.as_mut_ptr(), expected);
                            }
                            let _ = buffer.Unlock();

                            let enc_tex = uploader.upload(&slot)?;
                            converter.convert_bgra_to_nv12(enc_tex, &nv12_view)?;
                            sink.write_video_texture(&nv12_tex, timestamp_100ns, sample_dur_100ns)?;
                            frames_written += 1;
                        }
                    }

                    if last_emit.elapsed().as_millis() >= 150 {
                        let elapsed = t_start.elapsed().as_secs_f64();
                        let cur_fps = if elapsed > 0.05 { (frames_written as f64) / elapsed } else { 0.0 };
                        let pct = if total_dur_100ns > 0 {
                            ((timestamp_100ns as f64 / total_dur_100ns as f64) * 100.0).clamp(0.0, 99.0) as f32
                        } else {
                            50.0
                        };

                        on_progress(ExportProgress {
                            state: "exporting".to_string(),
                            progress_pct: pct,
                            elapsed_secs: elapsed,
                            current_fps: (cur_fps * 10.0).round() / 10.0,
                            output_path: None,
                            error: None,
                        });
                        last_emit = Instant::now();
                    }
                } else if stream_index == audio_stream_idx && has_audio {
                    if let Ok(buffer) = sample.ConvertToContiguousBuffer() {
                        let mut p_data = std::ptr::null_mut();
                        let mut max_len = 0u32;
                        let mut cur_len = 0u32;
                        if buffer.Lock(&mut p_data, Some(&mut max_len), Some(&mut cur_len)).is_ok() {
                            if cur_len > 0 && !p_data.is_null() {
                                let pcm_slice = std::slice::from_raw_parts(p_data, cur_len as usize);
                                let _ = sink.write_audio_pcm(pcm_slice, timestamp_100ns, sample_dur_100ns);
                            }
                            let _ = buffer.Unlock();
                        }
                    }
                }
            }
        }
    }

    sink.finalize()?;

    let final_elapsed = t_start.elapsed().as_secs_f64();
    let avg_fps = if final_elapsed > 0.05 { (frames_written as f64) / final_elapsed } else { 0.0 };

    on_progress(ExportProgress {
        state: "done".to_string(),
        progress_pct: 100.0,
        elapsed_secs: final_elapsed,
        current_fps: (avg_fps * 10.0).round() / 10.0,
        output_path: Some(config.output_path),
        error: None,
    });

    Ok(())
}

pub fn get_media_metadata(path_str: &str) -> Result<MediaAssetInfo, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Err(format!("Arquivo não encontrado: {path_str}"));
    }
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    let size_bytes = p.metadata().map(|m| m.len()).unwrap_or(0);

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

    unsafe {
        let hpath = HSTRING::from(path_str);
        let reader: IMFSourceReader = MFCreateSourceReaderFromURL(&hpath, None)
            .map_err(|e| format!("Falha ao abrir arquivo no Media Foundation: {e}"))?;

        let var_dur = reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .unwrap_or_default();
        let dur_100ns = PropVariantToInt64(&var_dur).unwrap_or(0);
        let duration_secs = (dur_100ns as f64) / 10_000_000.0;

        let mut width = 0u32;
        let mut height = 0u32;
        let mut fps = 0.0f64;

        if let Ok(video_mt) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32) {
            if let Ok(val) = video_mt.GetUINT64(&MF_MT_FRAME_SIZE) {
                width = (val >> 32) as u32;
                height = (val & 0xFFFFFFFF) as u32;
            }

            if let Ok(val) = video_mt.GetUINT64(&MF_MT_FRAME_RATE) {
                let num = (val >> 32) as u32;
                let den = (val & 0xFFFFFFFF) as u32;
                if den > 0 {
                    fps = (num as f64) / (den as f64);
                    fps = (fps * 100.0).round() / 100.0;
                }
            }
        }

        let mut audio_channels = 0u32;
        let mut audio_sample_rate = 0u32;

        if let Ok(audio_mt) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32) {
            if let Ok(ch) = audio_mt.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) {
                audio_channels = ch;
            }
            if let Ok(sr) = audio_mt.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) {
                audio_sample_rate = sr;
            }
        }

        let kind = if width > 0 && height > 0 {
            "video".to_string()
        } else {
            "audio".to_string()
        };

        let asset_id = format!("asset_{:x}", chrono::Utc::now().timestamp_micros());

        Ok(MediaAssetInfo {
            id: asset_id,
            name: filename,
            path: path_str.to_string(),
            kind,
            duration_secs,
            width,
            height,
            fps,
            audio_channels,
            audio_sample_rate,
            size_bytes,
        })
    }
}

pub fn decode_audio_file_to_pcm(path_str: &str) -> Result<Vec<i16>, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Err(format!("Arquivo de áudio não encontrado: {path_str}"));
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, 0).map_err(|e| format!("Falha MFStartup áudio: {e}"))?;
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

    unsafe {
        let hpath = HSTRING::from(path_str);
        let reader: IMFSourceReader = MFCreateSourceReaderFromURL(&hpath, None)
            .map_err(|e| format!("Falha ao abrir leitor de áudio ({path_str}): {e}"))?;

        let audio_out_mt = MFCreateMediaType().map_err(|e| format!("Falha MFCreateMediaType áudio: {e}"))?;
        audio_out_mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
        audio_out_mt.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| e.to_string())?;
        audio_out_mt.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(|e| e.to_string())?;
        audio_out_mt.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000).map_err(|e| e.to_string())?;
        audio_out_mt.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
        audio_out_mt.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4).map_err(|e| e.to_string())?;
        audio_out_mt.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48000 * 4).map_err(|e| e.to_string())?;

        reader.SetCurrentMediaType(
            MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
            None,
            &audio_out_mt,
        ).map_err(|e| format!("Falha ao configurar decodificador PCM 48kHz: {e}"))?;

        let mut samples_i16 = Vec::new();
        loop {
            let mut stream_index = 0u32;
            let mut stream_flags = 0u32;
            let mut timestamp_100ns = 0i64;
            let mut sample_opt = None;

            let hr = reader.ReadSample(
                MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                0,
                Some(&mut stream_index),
                Some(&mut stream_flags),
                Some(&mut timestamp_100ns),
                Some(&mut sample_opt),
            );

            if hr.is_err() || (stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                break;
            }

            if let Some(sample) = sample_opt {
                if let Ok(buffer) = sample.ConvertToContiguousBuffer() {
                    let mut p_data = std::ptr::null_mut();
                    let mut max_len = 0u32;
                    let mut cur_len = 0u32;
                    if buffer.Lock(&mut p_data, Some(&mut max_len), Some(&mut cur_len)).is_ok() {
                        if cur_len > 0 && !p_data.is_null() {
                            let num_i16 = (cur_len as usize) / 2;
                            let i16_slice = std::slice::from_raw_parts(p_data as *const i16, num_i16);
                            samples_i16.extend_from_slice(i16_slice);
                        }
                        let _ = buffer.Unlock();
                    }
                }
            }
        }

        Ok(samples_i16)
    }
}

pub fn run_timeline_export(config: TimelineExportConfig, app: AppHandle) -> Result<(), String> {
    export_timeline_sync(config, move |p| {
        let _ = app.emit("export-progress", p);
    })
}

pub fn export_timeline_sync<F>(config: TimelineExportConfig, on_progress: F) -> Result<(), String>
where
    F: Fn(ExportProgress),
{
    if config.clips.is_empty() {
        return Err("Nenhum clipe na timeline para exportar.".to_string());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = EXPORT_CANCEL_FLAG.write();
        *guard = Some(cancel_flag.clone());
    }

    // Identificar dimensões de saída
    let (first_w, first_h) = if let Ok(m) = get_video_metadata(&config.clips[0].source_path) {
        (m.width, m.height)
    } else {
        (1920, 1080)
    };

    let (out_w, out_h) = match config.resolution_mode.as_str() {
        "1080p" => (1920, 1080),
        "720p" => (1280, 720),
        "1440p" => (2560, 1440),
        "4k" => (3840, 2160),
        "custom" => (
            config.custom_width.unwrap_or(1920).max(320),
            config.custom_height.unwrap_or(1080).max(240),
        ),
        _ => (first_w, first_h),
    };

    let target_fps = if config.fps > 0 { config.fps } else { 60 };
    let bitrate_kbps = if config.bitrate_kbps > 0 { config.bitrate_kbps } else { 25000 };
    let frame_dur_100ns = (10_000_000.0 / target_fps as f64).round() as i64;

    let mut total_expected_duration_secs = 0.0f64;
    for clip in &config.clips {
        total_expected_duration_secs += (clip.out_point_secs - clip.in_point_secs).max(0.0);
    }
    let total_expected_100ns = (total_expected_duration_secs * 10_000_000.0) as i64;

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

    struct LoadedMusic {
        pcm_samples: Vec<i16>,
        start_timeline_secs: f64,
        in_point_secs: f64,
        duration_secs: f64,
        volume: f32,
        fade_in_secs: f64,
        fade_out_secs: f64,
    }

    let mut decoded_music: Vec<LoadedMusic> = Vec::new();
    for mt in &config.music_tracks {
        if !mt.is_muted && mt.volume > 0.001 {
            match decode_audio_file_to_pcm(&mt.source_path) {
                Ok(samples) => {
                    decoded_music.push(LoadedMusic {
                        pcm_samples: samples,
                        start_timeline_secs: mt.start_timeline_secs,
                        in_point_secs: mt.in_point_secs,
                        duration_secs: mt.duration_secs,
                        volume: mt.volume,
                        fade_in_secs: mt.fade_in_secs,
                        fade_out_secs: mt.fade_out_secs,
                    });
                }
                Err(e) => {
                    logger::warn("editor", &format!("Não foi possível carregar música {}: {e}", mt.source_path));
                }
            }
        }
    }

    let enc_d3d = D3D11Context::new().map_err(|e| format!("Falha D3D11 encoder: {e}"))?;

    let output_path = Path::new(&config.output_path);
    if let Some(parent) = output_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let sink = MediaSinkWriter::create(
        output_path,
        &enc_d3d.mf_dxgi_manager,
        out_w,
        out_h,
        target_fps,
        bitrate_kbps,
        true, // Sempre com áudio AAC estéreo integrado
        true, // prefer_hardware
    )?;

    let t_start = Instant::now();
    let mut last_emit = Instant::now();
    let mut timeline_video_pts_100ns: i64 = 0;
    let mut timeline_audio_pts_100ns: i64 = 0;
    let mut total_frames_written = 0u64;

    for (clip_idx, clip) in config.clips.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = sink.finalize();
            let _ = std::fs::remove_file(output_path);
            on_progress(ExportProgress {
                state: "cancelled".to_string(),
                progress_pct: 0.0,
                elapsed_secs: t_start.elapsed().as_secs_f64(),
                current_fps: 0.0,
                output_path: None,
                error: Some("Exportação cancelada pelo usuário.".to_string()),
            });
            return Ok(());
        }

        let clip_meta = match get_video_metadata(&clip.source_path) {
            Ok(m) => m,
            Err(e) => {
                logger::error("editor", &format!("Erro ao ler clipe #{clip_idx}: {e}"));
                continue;
            }
        };

        let clip_w = clip_meta.width.max(320);
        let clip_h = clip_meta.height.max(240);
        let has_clip_audio = clip_meta.audio_channels > 0;

        let mut uploader = EncBgraUploader::new(
            enc_d3d.device.clone(),
            enc_d3d.context.clone(),
            clip_w,
            clip_h,
        )?;

        let mut converter = GpuBgraToNv12::new(
            enc_d3d.device.clone(),
            enc_d3d.context.clone(),
            clip_w,
            clip_h,
            out_w,
            out_h,
            &config.framing_mode,
        )?;

        let (nv12_tex, nv12_view) = converter.create_nv12_texture()?;

        let hpath = HSTRING::from(&clip.source_path);
        let reader: IMFSourceReader = unsafe {
            let mut attrs = None;
            let _ = MFCreateAttributes(&mut attrs, 2);
            if let Some(ref a) = attrs {
                let _ = a.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
            }
            MFCreateSourceReaderFromURL(&hpath, attrs.as_ref())
                .map_err(|e| format!("Falha ao abrir leitor do clipe #{clip_idx}: {e}"))?
        };

        unsafe {
            let video_out_mt = MFCreateMediaType().map_err(|e| format!("Falha MFCreateMediaType: {e}"))?;
            video_out_mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            video_out_mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(|e| e.to_string())?;
            reader.SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &video_out_mt,
            ).map_err(|e| format!("Falha SetCurrentMediaType RGB32 clipe #{clip_idx}: {e}"))?;

            if has_clip_audio {
                let audio_out_mt = MFCreateMediaType().map_err(|e| format!("Falha MFCreateMediaType áudio: {e}"))?;
                audio_out_mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                audio_out_mt.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| e.to_string())?;
                audio_out_mt.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(|e| e.to_string())?;
                audio_out_mt.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000).map_err(|e| e.to_string())?;
                audio_out_mt.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
                audio_out_mt.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4).map_err(|e| e.to_string())?;
                audio_out_mt.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48000 * 4).map_err(|e| e.to_string())?;

                let _ = reader.SetCurrentMediaType(
                    MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                    None,
                    &audio_out_mt,
                );
            }
        }

        let mut video_stream_idx = 0u32;
        let mut audio_stream_idx = 1u32;
        unsafe {
            for idx in 0..8 {
                if let Ok(mt) = reader.GetCurrentMediaType(idx) {
                    if let Ok(major) = mt.GetGUID(&MF_MT_MAJOR_TYPE) {
                        if major == MFMediaType_Video {
                            video_stream_idx = idx;
                        } else if major == MFMediaType_Audio {
                            audio_stream_idx = idx;
                        }
                    }
                }
            }
        }

        let mut slot = SharedBgraSlot::new(clip_w, clip_h);
        let in_100ns = (clip.in_point_secs.max(0.0) * 10_000_000.0) as i64;
        let out_100ns = if clip.out_point_secs > clip.in_point_secs {
            (clip.out_point_secs * 10_000_000.0) as i64
        } else {
            (clip_meta.duration_secs * 10_000_000.0) as i64
        };

        let mut video_done = false;
        let mut audio_done = !has_clip_audio;

        while !video_done || (!audio_done && has_clip_audio) {
            if cancel_flag.load(Ordering::SeqCst) {
                let _ = sink.finalize();
                let _ = std::fs::remove_file(output_path);
                on_progress(ExportProgress {
                    state: "cancelled".to_string(),
                    progress_pct: 0.0,
                    elapsed_secs: t_start.elapsed().as_secs_f64(),
                    current_fps: 0.0,
                    output_path: None,
                    error: Some("Exportação cancelada pelo usuário.".to_string()),
                });
                return Ok(());
            }

            unsafe {
                let mut stream_index = 0u32;
                let mut stream_flags = 0u32;
                let mut timestamp_100ns = 0i64;
                let mut sample_opt = None;

                let hr = reader.ReadSample(
                    MF_SOURCE_READER_ANY_STREAM.0 as u32,
                    0,
                    Some(&mut stream_index),
                    Some(&mut stream_flags),
                    Some(&mut timestamp_100ns),
                    Some(&mut sample_opt),
                );

                if hr.is_err() {
                    break;
                }

                if (stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32) != 0 {
                    if stream_index == video_stream_idx {
                        video_done = true;
                    } else if stream_index == audio_stream_idx {
                        audio_done = true;
                    }
                    if video_done && (!has_clip_audio || audio_done) {
                        break;
                    }
                }

                if let Some(sample) = sample_opt {
                    if stream_index == video_stream_idx {
                        if timestamp_100ns < in_100ns {
                            continue;
                        }
                        if timestamp_100ns > out_100ns {
                            video_done = true;
                            continue;
                        }

                        if let Ok(buffer) = sample.ConvertToContiguousBuffer() {
                            let mut p_data = std::ptr::null_mut();
                            let mut max_len = 0u32;
                            let mut cur_len = 0u32;
                            if buffer.Lock(&mut p_data, Some(&mut max_len), Some(&mut cur_len)).is_ok() {
                                let expected = (slot.width as usize) * (slot.height as usize) * 4;
                                if (cur_len as usize) >= expected && !p_data.is_null() {
                                    std::ptr::copy_nonoverlapping(p_data, slot.data.as_mut_ptr(), expected);
                                }
                                let _ = buffer.Unlock();

                                let enc_tex = uploader.upload(&slot)?;
                                converter.convert_bgra_to_nv12(enc_tex, &nv12_view)?;
                                sink.write_video_texture(&nv12_tex, timeline_video_pts_100ns, frame_dur_100ns)?;
                                timeline_video_pts_100ns += frame_dur_100ns;
                                total_frames_written += 1;
                            }
                        }

                        if last_emit.elapsed().as_millis() >= 150 {
                            let elapsed = t_start.elapsed().as_secs_f64();
                            let cur_fps = if elapsed > 0.05 { (total_frames_written as f64) / elapsed } else { 0.0 };
                            let pct = if total_expected_100ns > 0 {
                                ((timeline_video_pts_100ns as f64 / total_expected_100ns as f64) * 100.0).clamp(0.0, 99.0) as f32
                            } else {
                                50.0
                            };

                            on_progress(ExportProgress {
                                state: "exporting".to_string(),
                                progress_pct: pct,
                                elapsed_secs: elapsed,
                                current_fps: (cur_fps * 10.0).round() / 10.0,
                                output_path: None,
                                error: None,
                            });
                            last_emit = Instant::now();
                        }
                    } else if stream_index == audio_stream_idx && has_clip_audio {
                        if timestamp_100ns < in_100ns {
                            continue;
                        }
                        if timestamp_100ns > out_100ns {
                            audio_done = true;
                            continue;
                        }

                        if let Ok(buffer) = sample.ConvertToContiguousBuffer() {
                            let mut p_data = std::ptr::null_mut();
                            let mut max_len = 0u32;
                            let mut cur_len = 0u32;
                            if buffer.Lock(&mut p_data, Some(&mut max_len), Some(&mut cur_len)).is_ok() {
                                if cur_len > 0 && !p_data.is_null() {
                                    let raw_slice = std::slice::from_raw_parts(p_data, cur_len as usize);
                                    let stereo_frames = (cur_len as usize) / 4;
                                    let sample_dur_100ns = (stereo_frames as i64 * 10_000_000) / 48000;

                                    let mut mixed_buf = vec![0u8; cur_len as usize];
                                    let game_vol = if clip.is_muted { 0.0 } else { clip.volume };

                                    for f in 0..stereo_frames {
                                        let sample_timeline_secs = (timeline_audio_pts_100ns as f64 / 10_000_000.0)
                                            + (f as f64 / 48000.0);

                                        let g_l = i16::from_le_bytes([raw_slice[f*4], raw_slice[f*4+1]]);
                                        let g_r = i16::from_le_bytes([raw_slice[f*4+2], raw_slice[f*4+3]]);

                                        let mut acc_l = (g_l as f32) * game_vol;
                                        let mut acc_r = (g_r as f32) * game_vol;

                                        for m in &decoded_music {
                                            let m_end = m.start_timeline_secs + m.duration_secs;
                                            if sample_timeline_secs >= m.start_timeline_secs && sample_timeline_secs < m_end {
                                                let rel_t = sample_timeline_secs - m.start_timeline_secs;
                                                let fade = if m.fade_in_secs > 0.0 && rel_t < m.fade_in_secs {
                                                    (rel_t / m.fade_in_secs) as f32
                                                } else if m.fade_out_secs > 0.0 && rel_t > (m.duration_secs - m.fade_out_secs) {
                                                    (((m.duration_secs - rel_t) / m.fade_out_secs).max(0.0)) as f32
                                                } else {
                                                    1.0f32
                                                };

                                                let m_src_secs = m.in_point_secs + rel_t;
                                                let m_frame = (m_src_secs * 48000.0) as usize;
                                                let s_idx = m_frame * 2;
                                                if s_idx + 1 < m.pcm_samples.len() {
                                                    acc_l += (m.pcm_samples[s_idx] as f32) * m.volume * fade;
                                                    acc_r += (m.pcm_samples[s_idx + 1] as f32) * m.volume * fade;
                                                }
                                            }
                                        }

                                        let out_l = acc_l.clamp(-32768.0, 32767.0) as i16;
                                        let out_r = acc_r.clamp(-32768.0, 32767.0) as i16;

                                        mixed_buf[f*4..f*4+2].copy_from_slice(&out_l.to_le_bytes());
                                        mixed_buf[f*4+2..f*4+4].copy_from_slice(&out_r.to_le_bytes());
                                    }

                                    let _ = sink.write_audio_pcm(&mixed_buf, timeline_audio_pts_100ns, sample_dur_100ns);
                                    timeline_audio_pts_100ns += sample_dur_100ns;
                                }
                                let _ = buffer.Unlock();
                            }
                        }
                    }
                }
            }
        }
    }

    // Preenchimento de áudio final caso timeline de áudio tenha ficado menor que o vídeo
    while timeline_audio_pts_100ns < timeline_video_pts_100ns {
        let remaining_100ns = timeline_video_pts_100ns - timeline_audio_pts_100ns;
        let chunk_dur_100ns = remaining_100ns.min(213_333);
        let stereo_frames = ((chunk_dur_100ns * 48000) / 10_000_000).max(1) as usize;
        let actual_chunk_dur_100ns = (stereo_frames as i64 * 10_000_000) / 48000;

        let mut mixed_buf = vec![0u8; stereo_frames * 4];
        for f in 0..stereo_frames {
            let sample_timeline_secs = (timeline_audio_pts_100ns as f64 / 10_000_000.0) + (f as f64 / 48000.0);
            let mut acc_l = 0.0f32;
            let mut acc_r = 0.0f32;

            for m in &decoded_music {
                let m_end = m.start_timeline_secs + m.duration_secs;
                if sample_timeline_secs >= m.start_timeline_secs && sample_timeline_secs < m_end {
                    let rel_t = sample_timeline_secs - m.start_timeline_secs;
                    let fade = if m.fade_in_secs > 0.0 && rel_t < m.fade_in_secs {
                        (rel_t / m.fade_in_secs) as f32
                    } else if m.fade_out_secs > 0.0 && rel_t > (m.duration_secs - m.fade_out_secs) {
                        (((m.duration_secs - rel_t) / m.fade_out_secs).max(0.0)) as f32
                    } else {
                        1.0f32
                    };
                    let m_src_secs = m.in_point_secs + rel_t;
                    let m_frame = (m_src_secs * 48000.0) as usize;
                    let s_idx = m_frame * 2;
                    if s_idx + 1 < m.pcm_samples.len() {
                        acc_l += (m.pcm_samples[s_idx] as f32) * m.volume * fade;
                        acc_r += (m.pcm_samples[s_idx + 1] as f32) * m.volume * fade;
                    }
                }
            }

            let out_l = acc_l.clamp(-32768.0, 32767.0) as i16;
            let out_r = acc_r.clamp(-32768.0, 32767.0) as i16;
            mixed_buf[f*4..f*4+2].copy_from_slice(&out_l.to_le_bytes());
            mixed_buf[f*4+2..f*4+4].copy_from_slice(&out_r.to_le_bytes());
        }

        let _ = sink.write_audio_pcm(&mixed_buf, timeline_audio_pts_100ns, actual_chunk_dur_100ns);
        timeline_audio_pts_100ns += actual_chunk_dur_100ns;
    }

    sink.finalize()?;

    let final_elapsed = t_start.elapsed().as_secs_f64();
    let avg_fps = if final_elapsed > 0.05 { (total_frames_written as f64) / final_elapsed } else { 0.0 };

    on_progress(ExportProgress {
        state: "done".to_string(),
        progress_pct: 100.0,
        elapsed_secs: final_elapsed,
        current_fps: (avg_fps * 10.0).round() / 10.0,
        output_path: Some(config.output_path),
        error: None,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TimelineClipExport;

    #[test]
    fn test_read_kn_reference_video_metadata() {
        let ravix_clip = r"C:\Users\Santarosa\Downloads\ravix.mp4";
        if std::path::Path::new(ravix_clip).exists() {
            let meta = get_video_metadata(ravix_clip).expect("Failed to get metadata for ravix.mp4");
            eprintln!("[metadata] ravix.mp4: {}x{} dur={:.2}s fps={:.1} audio={}", meta.width, meta.height, meta.duration_secs, meta.fps, meta.audio_codec);
            assert_eq!(meta.width, 1100);
            assert_eq!(meta.height, 1080);
            assert!(meta.duration_secs > 5.0);
        }

        let obs_clip = r"C:\Users\Santarosa\Downloads\Replay_2026-11-12_14-20-45.mp4";
        if std::path::Path::new(obs_clip).exists() {
            let meta = get_video_metadata(obs_clip).expect("Failed to get metadata for OBS clip");
            eprintln!("[metadata] OBS clip: {}x{} dur={:.2}s fps={:.1} audio={}", meta.width, meta.height, meta.duration_secs, meta.fps, meta.audio_codec);
            assert_eq!(meta.width, 1920);
            assert_eq!(meta.height, 1080);
            assert!(meta.duration_secs > 10.0);
        }
    }

    #[test]
    fn test_export_stretched_video_from_kn_clip() {
        let ravix_clip = r"C:\Users\Santarosa\Downloads\ravix.mp4";
        if !std::path::Path::new(ravix_clip).exists() {
            eprintln!("ravix.mp4 not found, skipping export test");
            return;
        }

        let out_dir = std::env::temp_dir().join("ravix_test_export");
        let _ = std::fs::create_dir_all(&out_dir);
        let out_file = out_dir.join("ravix_stretched_1080p.mp4");
        let _ = std::fs::remove_file(&out_file);

        let cfg = ExportConfig {
            input_path: ravix_clip.to_string(),
            output_path: out_file.to_string_lossy().to_string(),
            resolution_mode: "1080p".to_string(),
            custom_width: None,
            custom_height: None,
            framing_mode: "stretch".to_string(),
            fps: 60,
            bitrate_kbps: 25000,
        };

        let res = export_video_sync(cfg, |p| {
            if (p.progress_pct as u32) % 25 == 0 {
                eprintln!("[export] state={} pct={:.0}% fps={:.1}", p.state, p.progress_pct, p.current_fps);
            }
        });
        assert!(res.is_ok(), "export_video_sync failed: {:?}", res);

        assert!(out_file.exists());
        let meta = get_video_metadata(&out_file.to_string_lossy()).expect("Failed to get exported metadata");
        eprintln!("[exported] meta: {}x{} dur={:.2}s fps={:.1} audio={}", meta.width, meta.height, meta.duration_secs, meta.fps, meta.audio_codec);
        assert_eq!(meta.width, 1920);
        assert_eq!(meta.height, 1080);
        assert!(meta.duration_secs > 5.0);
        assert!(meta.size_bytes > 1_000_000);

        let _ = std::fs::remove_file(&out_file);
        let _ = std::fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn test_export_timeline_multi_clip_sequence() {
        let test_video = r"C:\Users\Santarosa\Videos\RAVIX\RAVIX_2026-11-12_13-52-38.mp4";
        let target_video = if std::path::Path::new(test_video).exists() {
            test_video
        } else {
            r"C:\Users\Santarosa\Downloads\ravix.mp4"
        };

        if !std::path::Path::new(target_video).exists() {
            eprintln!("Vídeo de teste não encontrado, pulando test_export_timeline_multi_clip_sequence");
            return;
        }

        let out_dir = std::env::temp_dir().join("ravix_timeline_test");
        let _ = std::fs::create_dir_all(&out_dir);
        let out_file = out_dir.join("montage_test_1080p.mp4");
        let _ = std::fs::remove_file(&out_file);

        let cfg = TimelineExportConfig {
            output_path: out_file.to_string_lossy().to_string(),
            resolution_mode: "1080p".to_string(),
            custom_width: None,
            custom_height: None,
            framing_mode: "fit".to_string(),
            fps: 60,
            bitrate_kbps: 15000,
            clips: vec![
                TimelineClipExport {
                    id: "clip_1".to_string(),
                    source_path: target_video.to_string(),
                    in_point_secs: 0.0,
                    out_point_secs: 2.0,
                    volume: 1.0,
                    is_muted: false,
                },
                TimelineClipExport {
                    id: "clip_2".to_string(),
                    source_path: target_video.to_string(),
                    in_point_secs: 2.5,
                    out_point_secs: 4.5,
                    volume: 0.8,
                    is_muted: false,
                },
            ],
            music_tracks: vec![],
        };

        let res = export_timeline_sync(cfg, |p| {
            eprintln!("[timeline export] state={} pct={:.0}% fps={:.1}", p.state, p.progress_pct, p.current_fps);
        });

        assert!(res.is_ok(), "export_timeline_sync falhou: {:?}", res);
        assert!(out_file.exists(), "Arquivo exportado não existe");

        let meta = get_video_metadata(&out_file.to_string_lossy()).expect("Falha ao obter metadados do vídeo montado");
        eprintln!("[montagem pronta] {}x{} dur={:.2}s fps={:.1} audio={}", meta.width, meta.height, meta.duration_secs, meta.fps, meta.audio_codec);
        assert_eq!(meta.width, 1920);
        assert_eq!(meta.height, 1080);
        assert!((meta.duration_secs - 4.0).abs() < 0.5, "Duração esperada ~4.0s, obtido {:.2}s", meta.duration_secs);
        assert!(meta.size_bytes > 500_000, "Arquivo montado muito pequeno: {} bytes", meta.size_bytes);

        let _ = std::fs::remove_file(&out_file);
        let _ = std::fs::remove_dir_all(&out_dir);
    }
}
