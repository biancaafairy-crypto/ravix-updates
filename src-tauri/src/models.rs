use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: String, // "window" | "monitor"
    pub title: String,
    pub process_name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: u32,
    pub is_game_priority: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderOption {
    pub id: String,
    pub name: String,
    pub vendor: String, // "AMD" | "NVIDIA" | "Intel" | "Software"
    pub codec: String,  // "H264"
    pub is_hardware: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceOption {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub kind: String, // "render" | "capture"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapabilities {
    pub sources: Vec<CaptureSource>,
    pub encoders: Vec<EncoderOption>,
    pub render_devices: Vec<AudioDeviceOption>,
    pub capture_devices: Vec<AudioDeviceOption>,
    pub supported_fps: Vec<u32>,
    pub default_output_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub source_kind: String, // "window" | "monitor"
    pub source_id: String,
    pub output_dir: String,
    pub resolution_mode: String, // "native" | "1080p" | "900p" | "720p"
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub encoder_id: String,
    pub system_audio_enabled: bool,
    pub system_audio_device_id: Option<String>,
    pub mic_enabled: bool,
    pub mic_device_id: Option<String>,
    pub duration_limit_secs: Option<u64>,
    pub segment_minutes: Option<u64>,
    pub hotkey: String,
    pub min_free_disk_mb: u64,
    pub minimize_to_tray_on_close: bool,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        let default_dir = dirs::video_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("C:\\")))
            .join("RAVIX")
            .to_string_lossy()
            .to_string();

        Self {
            source_kind: "monitor".to_string(),
            source_id: String::new(),
            output_dir: default_dir,
            resolution_mode: "native".to_string(),
            fps: 60,
            bitrate_kbps: 25000,
            encoder_id: String::new(),
            system_audio_enabled: true,
            system_audio_device_id: None,
            mic_enabled: false,
            mic_device_id: None,
            duration_limit_secs: None,
            segment_minutes: Some(30),
            hotkey: "F9".to_string(),
            min_free_disk_mb: 2048,
            minimize_to_tray_on_close: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub state: String, // "idle" | "starting" | "recording" | "stopping" | "error"
    pub elapsed_secs: f64,
    pub duration_limit_secs: Option<u64>,
    pub current_file: Option<String>,
    pub current_segment: u32,
    pub frames_captured: u64,
    pub frames_written: u64,
    pub frames_dropped: u64,
    pub encoder_errors: u64,
    pub actual_fps: f64,
    pub target_fps: u32,
    pub fps_warning: Option<String>,
    pub cpu_usage_pct: f32,
    pub memory_mb: f64,
    pub free_disk_gb: f64,
    pub active_encoder_name: Option<String>,
    pub last_error: Option<String>,
}

impl Default for RecorderStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            elapsed_secs: 0.0,
            duration_limit_secs: None,
            current_file: None,
            current_segment: 0,
            frames_captured: 0,
            frames_written: 0,
            frames_dropped: 0,
            encoder_errors: 0,
            actual_fps: 0.0,
            target_fps: 60,
            fps_warning: None,
            cpu_usage_pct: 0.0,
            memory_mb: 0.0,
            free_disk_gb: 0.0,
            active_encoder_name: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedFileInfo {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub modified_ts: i64,
}
