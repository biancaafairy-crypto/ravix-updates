use crate::d3d11::{D3D11Context, EncBgraUploader, GpuBgraToNv12, SharedBgraSlot};
use crate::geometry::compute_target_dimensions;
use crate::models::{ExportConfig, ExportProgress, VideoMetadata};
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
