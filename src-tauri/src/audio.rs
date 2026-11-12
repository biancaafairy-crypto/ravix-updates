use crossbeam_channel::Sender;
use std::collections::VecDeque;
use std::os::windows::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eRender, IAudioCaptureClient, IAudioClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u16 = 2;
pub const AUDIO_BITS_PER_SAMPLE: u16 = 16;
const CHUNK_FRAMES: usize = 960; // 20ms @ 48kHz
const CHUNK_DURATION_100NS: i64 = 200_000; // 20ms em unidades de 100ns
const MAX_BUFFER_SAMPLES: usize = AUDIO_SAMPLE_RATE as usize * 2 / 5; // 200ms máx de buffer em i16 (stereo)

#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub data: Vec<u8>,
    pub timestamp_100ns: i64,
    pub duration_100ns: i64,
}

struct WasapiCaptureStream {
    audio_client: IAudioClient,
    capture_client: IAudioCaptureClient,
    buffer: VecDeque<i16>,
}

impl WasapiCaptureStream {
    unsafe fn open(is_loopback: bool, device_id: Option<&str>) -> Result<Self, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("Falha ao criar IMMDeviceEnumerator: {e}"))?;

        let device: IMMDevice = if let Some(id) = device_id.filter(|s| !s.trim().is_empty()) {
            let wide: Vec<u16> = std::ffi::OsStr::new(id)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(|e| format!("Dispositivo de áudio não encontrado ({id}): {e}"))?
        } else if is_loopback {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("Sem dispositivo de reprodução padrão: {e}"))?
        } else {
            enumerator
                .GetDefaultAudioEndpoint(eCapture, eCommunications)
                .or_else(|_| enumerator.GetDefaultAudioEndpoint(eCapture, eConsole))
                .map_err(|e| format!("Sem microfone padrão disponível: {e}"))?
        };

        let audio_client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Falha ao ativar IAudioClient: {e}"))?;

        let block_align = AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: AUDIO_CHANNELS,
            nSamplesPerSec: AUDIO_SAMPLE_RATE,
            nAvgBytesPerSec: AUDIO_SAMPLE_RATE * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: AUDIO_BITS_PER_SAMPLE,
            cbSize: 0,
        };

        let mut flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        if is_loopback {
            flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
        }

        // Buffer de 100ms (1_000_000 em 100ns)
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                1_000_000,
                0,
                &format,
                None,
            )
            .map_err(|e| format!("Falha IAudioClient::Initialize: {e}"))?;

        let capture_client: IAudioCaptureClient = audio_client
            .GetService()
            .map_err(|e| format!("Falha ao obter IAudioCaptureClient: {e}"))?;

        audio_client
            .Start()
            .map_err(|e| format!("Falha IAudioClient::Start: {e}"))?;

        Ok(Self {
            audio_client,
            capture_client,
            buffer: VecDeque::with_capacity(MAX_BUFFER_SAMPLES),
        })
    }

    unsafe fn drain_packets(&mut self) {
        loop {
            let Ok(packet_frames) = self.capture_client.GetNextPacketSize() else {
                break;
            };
            if packet_frames == 0 {
                break;
            }

            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames_available: u32 = 0;
            let mut flags: u32 = 0;

            if self
                .capture_client
                .GetBuffer(
                    &mut data_ptr,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                )
                .is_err()
            {
                break;
            }

            let samples_count = frames_available as usize * AUDIO_CHANNELS as usize;
            if (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null() {
                for _ in 0..samples_count {
                    self.buffer.push_back(0);
                }
            } else {
                let pcm_slice = std::slice::from_raw_parts(data_ptr as *const i16, samples_count);
                for &s in pcm_slice {
                    self.buffer.push_back(s);
                }
            }

            let _ = self.capture_client.ReleaseBuffer(frames_available);

            while self.buffer.len() > MAX_BUFFER_SAMPLES {
                self.buffer.pop_front();
            }
        }
    }

    fn take_chunk_samples(&mut self, needed_samples: usize, out: &mut [i16]) {
        for slot in out.iter_mut().take(needed_samples) {
            *slot = self.buffer.pop_front().unwrap_or(0);
        }
    }
}

impl Drop for WasapiCaptureStream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.audio_client.Stop();
        }
    }
}

pub struct AudioCaptureHandle {
    stop_flag: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl AudioCaptureHandle {
    pub fn start(
        system_enabled: bool,
        system_device_id: Option<String>,
        mic_enabled: bool,
        mic_device_id: Option<String>,
        t0_qpc: i64,
        qpc_freq: i64,
        audio_tx: Sender<AudioChunk>,
    ) -> Result<Self, String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = stop_flag.clone();

        let (init_tx, init_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);

        let handle = thread::Builder::new()
            .name("ravix-audio".to_string())
            .spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

                let mut sys_stream = if system_enabled {
                    match WasapiCaptureStream::open(true, system_device_id.as_deref()) {
                        Ok(s) => Some(s),
                        Err(e) => {
                            let _ = init_tx.send(Err(e));
                            CoUninitialize();
                            return;
                        }
                    }
                } else {
                    None
                };

                let mut mic_stream = if mic_enabled {
                    match WasapiCaptureStream::open(false, mic_device_id.as_deref()) {
                        Ok(s) => Some(s),
                        Err(e) => {
                            let _ = init_tx.send(Err(e));
                            CoUninitialize();
                            return;
                        }
                    }
                } else {
                    None
                };

                let _ = init_tx.send(Ok(()));

                let samples_per_chunk = CHUNK_FRAMES * AUDIO_CHANNELS as usize;
                let mut sys_buf = vec![0i16; samples_per_chunk];
                let mut mic_buf = vec![0i16; samples_per_chunk];
                let mut next_pts_100ns: i64 = 0;

                while !stop_clone.load(Ordering::Relaxed) {
                    if let Some(ref mut s) = sys_stream {
                        s.drain_packets();
                    }
                    if let Some(ref mut m) = mic_stream {
                        m.drain_packets();
                    }

                    let now_100ns = qpc_elapsed_100ns(t0_qpc, qpc_freq);

                    // Emitir blocos exatos de 20ms acompanhando o relógio QPC mestre
                    while now_100ns >= next_pts_100ns + CHUNK_DURATION_100NS {
                        if let Some(ref mut s) = sys_stream {
                            s.take_chunk_samples(samples_per_chunk, &mut sys_buf);
                        } else {
                            sys_buf.fill(0);
                        }

                        if let Some(ref mut m) = mic_stream {
                            m.take_chunk_samples(samples_per_chunk, &mut mic_buf);
                        } else {
                            mic_buf.fill(0);
                        }

                        let mut bytes = Vec::with_capacity(samples_per_chunk * 2);
                        for i in 0..samples_per_chunk {
                            let mixed = (sys_buf[i] as i32 + mic_buf[i] as i32)
                                .clamp(i16::MIN as i32, i16::MAX as i32)
                                as i16;
                            bytes.extend_from_slice(&mixed.to_le_bytes());
                        }

                        let _ = audio_tx.try_send(AudioChunk {
                            data: bytes,
                            timestamp_100ns: next_pts_100ns,
                            duration_100ns: CHUNK_DURATION_100NS,
                        });

                        next_pts_100ns += CHUNK_DURATION_100NS;
                    }

                    thread::sleep(Duration::from_millis(5));
                }

                drop(sys_stream);
                drop(mic_stream);
                CoUninitialize();
            })
            .map_err(|e| format!("Falha ao iniciar thread de áudio: {e}"))?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop_flag,
                join_handle: Some(handle),
            }),
            Ok(Err(e)) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err("Thread de áudio encerrou inesperadamente durante inicialização.".to_string())
            }
        }
    }

    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(h) = self.join_handle.take() {
            let _ = h.join();
        }
    }
}

pub fn current_qpc() -> (i64, i64) {
    unsafe {
        let mut now = 0i64;
        let mut freq = 1i64;
        let _ = QueryPerformanceCounter(&mut now);
        let _ = QueryPerformanceFrequency(&mut freq);
        (now, freq.max(1))
    }
}

pub fn qpc_elapsed_100ns(t0_qpc: i64, qpc_freq: i64) -> i64 {
    unsafe {
        let mut now = 0i64;
        let _ = QueryPerformanceCounter(&mut now);
        let delta = (now - t0_qpc).max(0) as i128;
        ((delta * 10_000_000i128) / (qpc_freq as i128)) as i64
    }
}
