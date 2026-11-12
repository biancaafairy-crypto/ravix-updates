use crate::audio::{AUDIO_BITS_PER_SAMPLE, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_High, IMFAttributes, IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaType,
    IMFSample, IMFSinkWriter, IMF2DBuffer, MFAudioFormat_AAC, MFAudioFormat_PCM,
    MFCreateAttributes, MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio, MFMediaType_Video,
    MFTranscodeContainerType_FMPEG4, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_D3D_MANAGER,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_TRANSCODE_CONTAINERTYPE,
};

fn pack_u64(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | (lo as u64)
}

pub struct MediaSinkWriter {
    writer: IMFSinkWriter,
    video_stream_index: u32,
    audio_stream_index: Option<u32>,
    nv12_expected_len: u32,
}

unsafe impl Send for MediaSinkWriter {}

impl MediaSinkWriter {
    pub fn create(
        output_path: &Path,
        mf_dxgi_manager: &IMFDXGIDeviceManager,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_kbps: u32,
        has_audio: bool,
        prefer_hardware: bool,
    ) -> Result<Self, String> {
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 4)
                .map_err(|e| format!("Falha MFCreateAttributes: {e}"))?;
            let attrs = attrs.ok_or("IMFAttributes nulo")?;

            attrs
                .SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, mf_dxgi_manager)
                .map_err(|e| format!("Falha SetUnknown D3D_MANAGER: {e}"))?;
            attrs
                .SetUINT32(
                    &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                    if prefer_hardware { 1 } else { 0 },
                )
                .map_err(|e| format!("Falha SetUINT32 ENABLE_HARDWARE_TRANSFORMS: {e}"))?;
            attrs
                .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                .map_err(|e| format!("Falha SetUINT32 DISABLE_THROTTLING: {e}"))?;
            // Fragmented MP4 resiliente para evitar perda total em crashes/interrupções
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_FMPEG4)
                .map_err(|e| format!("Falha SetGUID FMPEG4: {e}"))?;

            let wide_path: Vec<u16> = output_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();

            let writer = MFCreateSinkWriterFromURL(
                PCWSTR(wide_path.as_ptr()),
                None,
                &attrs,
            )
            .map_err(|e| format!("Falha MFCreateSinkWriterFromURL: {e}"))?;

            // 1. Configurar Stream de Vídeo H.264
            let out_video: IMFMediaType = MFCreateMediaType()
                .map_err(|e| format!("Falha MFCreateMediaType out_video: {e}"))?;
            out_video.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            out_video.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| e.to_string())?;
            out_video
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate_kbps.saturating_mul(1000))
                .map_err(|e| e.to_string())?;
            out_video
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            out_video
                .SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width, height))
                .map_err(|e| e.to_string())?;
            out_video
                .SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps, 1))
                .map_err(|e| e.to_string())?;
            out_video
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1))
                .map_err(|e| e.to_string())?;
            out_video
                .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                .map_err(|e| e.to_string())?;

            let video_stream_index = writer
                .AddStream(&out_video)
                .map_err(|e| format!("Falha AddStream Vídeo H.264: {e}"))?;

            let in_video: IMFMediaType = MFCreateMediaType()
                .map_err(|e| format!("Falha MFCreateMediaType in_video: {e}"))?;
            in_video.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            in_video.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            in_video
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            in_video
                .SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width, height))
                .map_err(|e| e.to_string())?;
            in_video
                .SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps, 1))
                .map_err(|e| e.to_string())?;
            in_video
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1))
                .map_err(|e| e.to_string())?;

            writer
                .SetInputMediaType(video_stream_index, &in_video, None)
                .map_err(|e| format!("Falha SetInputMediaType Vídeo NV12: {e}"))?;

            // 2. Configurar Stream de Áudio AAC (se habilitado)
            let audio_stream_index = if has_audio {
                let out_audio: IMFMediaType = MFCreateMediaType()
                    .map_err(|e| format!("Falha MFCreateMediaType out_audio: {e}"))?;
                out_audio.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                out_audio.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(|e| e.to_string())?;
                out_audio
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS_PER_SAMPLE as u32)
                    .map_err(|e| e.to_string())?;
                out_audio
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_SAMPLE_RATE)
                    .map_err(|e| e.to_string())?;
                out_audio
                    .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS as u32)
                    .map_err(|e| e.to_string())?;
                out_audio
                    .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000) // 192 kbps
                    .map_err(|e| e.to_string())?;

                let a_idx = writer
                    .AddStream(&out_audio)
                    .map_err(|e| format!("Falha AddStream Áudio AAC: {e}"))?;

                let in_audio: IMFMediaType = MFCreateMediaType()
                    .map_err(|e| format!("Falha MFCreateMediaType in_audio: {e}"))?;
                let block_align = AUDIO_CHANNELS as u32 * (AUDIO_BITS_PER_SAMPLE as u32 / 8);
                in_audio.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
                in_audio.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| e.to_string())?;
                in_audio
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS_PER_SAMPLE as u32)
                    .map_err(|e| e.to_string())?;
                in_audio
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_SAMPLE_RATE)
                    .map_err(|e| e.to_string())?;
                in_audio
                    .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS as u32)
                    .map_err(|e| e.to_string())?;
                in_audio
                    .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align)
                    .map_err(|e| e.to_string())?;
                in_audio
                    .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUDIO_SAMPLE_RATE * block_align)
                    .map_err(|e| e.to_string())?;

                writer
                    .SetInputMediaType(a_idx, &in_audio, None)
                    .map_err(|e| format!("Falha SetInputMediaType Áudio PCM: {e}"))?;

                Some(a_idx)
            } else {
                None
            };

            writer
                .BeginWriting()
                .map_err(|e| format!("Falha BeginWriting no SinkWriter: {e}"))?;

            let nv12_expected_len = (width * height * 3) / 2;

            Ok(Self {
                writer,
                video_stream_index,
                audio_stream_index,
                nv12_expected_len,
            })
        }
    }

    pub fn write_video_texture(
        &self,
        nv12_tex: &ID3D11Texture2D,
        timestamp_100ns: i64,
        duration_100ns: i64,
    ) -> Result<(), String> {
        unsafe {
            let buffer: IMFMediaBuffer = MFCreateDXGISurfaceBuffer(
                &ID3D11Texture2D::IID,
                nv12_tex,
                0,
                false,
            )
            .map_err(|e| format!("Falha MFCreateDXGISurfaceBuffer: {e}"))?;

            let len = if let Ok(buf2d) = buffer.cast::<IMF2DBuffer>() {
                buf2d.GetContiguousLength().unwrap_or(self.nv12_expected_len)
            } else {
                self.nv12_expected_len
            };
            let _ = buffer.SetCurrentLength(len);

            let sample: IMFSample = MFCreateSample()
                .map_err(|e| format!("Falha MFCreateSample vídeo: {e}"))?;
            sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            sample.SetSampleTime(timestamp_100ns).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(duration_100ns).map_err(|e| e.to_string())?;

            self.writer
                .WriteSample(self.video_stream_index, &sample)
                .map_err(|e| format!("Falha WriteSample vídeo: {e}"))
        }
    }

    pub fn write_audio_pcm(
        &self,
        pcm_bytes: &[u8],
        timestamp_100ns: i64,
        duration_100ns: i64,
    ) -> Result<(), String> {
        let Some(a_idx) = self.audio_stream_index else {
            return Ok(());
        };
        unsafe {
            let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(pcm_bytes.len() as u32)
                .map_err(|e| format!("Falha MFCreateMemoryBuffer áudio: {e}"))?;

            let mut dst_ptr: *mut u8 = std::ptr::null_mut();
            let mut max_len: u32 = 0;
            buffer
                .Lock(&mut dst_ptr, Some(&mut max_len), None)
                .map_err(|e| format!("Falha Buffer Lock áudio: {e}"))?;
            std::ptr::copy_nonoverlapping(pcm_bytes.as_ptr(), dst_ptr, pcm_bytes.len());
            let _ = buffer.Unlock();
            buffer
                .SetCurrentLength(pcm_bytes.len() as u32)
                .map_err(|e| e.to_string())?;

            let sample: IMFSample = MFCreateSample()
                .map_err(|e| format!("Falha MFCreateSample áudio: {e}"))?;
            sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            sample.SetSampleTime(timestamp_100ns).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(duration_100ns).map_err(|e| e.to_string())?;

            self.writer
                .WriteSample(a_idx, &sample)
                .map_err(|e| format!("Falha WriteSample áudio: {e}"))
        }
    }

    pub fn finalize(self) -> Result<(), String> {
        unsafe {
            self.writer
                .Finalize()
                .map_err(|e| format!("Falha Finalize arquivo de vídeo: {e}"))
        }
    }
}
