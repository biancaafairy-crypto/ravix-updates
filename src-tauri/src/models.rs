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

fn default_framing_mode() -> String {
    "stretch".to_string()
}

fn default_true() -> bool {
    true
}

fn default_beta_channel() -> String {
    "beta".to_string()
}

fn default_replay_hotkey() -> String {
    "F8".to_string()
}

fn default_replay_duration() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub source_kind: String, // "window" | "monitor"
    pub source_id: String,
    pub output_dir: String,
    pub resolution_mode: String, // "native" | "1080p" | "1440p" | "custom"
    #[serde(default)]
    pub custom_width: Option<u32>,
    #[serde(default)]
    pub custom_height: Option<u32>,
    #[serde(default = "default_framing_mode")]
    pub framing_mode: String, // "stretch" | "fit" | "fill_crop"
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
    #[serde(default)]
    pub auto_start_with_windows: bool,
    #[serde(default = "default_true")]
    pub auto_check_updates: bool,
    #[serde(default = "default_beta_channel")]
    pub update_channel: String,
    #[serde(default = "default_replay_hotkey")]
    pub replay_hotkey: String,
    #[serde(default = "default_replay_duration")]
    pub replay_duration_secs: u32,
    #[serde(default)]
    pub replay_folder: Option<String>,
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
            resolution_mode: "1080p".to_string(),
            custom_width: None,
            custom_height: None,
            framing_mode: "stretch".to_string(),
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
            auto_start_with_windows: false,
            auto_check_updates: true,
            update_channel: "beta".to_string(),
            replay_hotkey: "F8".to_string(),
            replay_duration_secs: 30,
            replay_folder: None,
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
    pub source_width: u32,
    pub source_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub framing_mode: String,
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
            source_width: 0,
            source_height: 0,
            output_width: 0,
            output_height: 0,
            framing_mode: "stretch".to_string(),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub path: String,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    pub duration_secs: f64,
    pub fps: f64,
    pub bitrate_kbps: u32,
    pub video_codec: String,
    pub audio_codec: String,
    pub audio_channels: u32,
    pub audio_sample_rate: u32,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConfig {
    pub input_path: String,
    pub output_path: String,
    pub resolution_mode: String, // "original" | "1080p" | "1440p" | "custom"
    pub custom_width: Option<u32>,
    pub custom_height: Option<u32>,
    pub framing_mode: String, // "stretch" | "fit" | "fill_crop"
    pub fps: u32,
    pub bitrate_kbps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub state: String, // "idle" | "exporting" | "done" | "error" | "cancelled"
    #[serde(alias = "progress_pct")]
    pub progress_pct: f32,
    #[serde(alias = "elapsed_secs")]
    pub elapsed_secs: f64,
    #[serde(alias = "current_fps")]
    pub current_fps: f64,
    #[serde(alias = "output_path")]
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String, // "video" | "audio"
    pub duration_secs: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub audio_channels: u32,
    pub audio_sample_rate: u32,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClipExport {
    pub id: String,
    pub source_path: String,
    pub in_point_secs: f64,
    pub out_point_secs: f64,
    pub volume: f32, // 0.0 a 2.0
    pub is_muted: bool,
    #[serde(default)]
    pub scale: Option<f32>,
    #[serde(default)]
    pub position_x: Option<f32>,
    #[serde(default)]
    pub position_y: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackExport {
    pub id: String,
    pub source_path: String,
    pub start_timeline_secs: f64,
    pub in_point_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub is_muted: bool,
    pub fade_in_secs: f64,
    pub fade_out_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineExportConfig {
    pub output_path: String,
    pub resolution_mode: String,
    pub custom_width: Option<u32>,
    pub custom_height: Option<u32>,
    pub framing_mode: String, // "fit" | "stretch" | "fill_crop"
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub clips: Vec<TimelineClipExport>,
    pub music_tracks: Vec<AudioTrackExport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct TimelineClipData {
    pub id: String,
    pub asset_id: String,
    pub source_path: String,
    pub name: String,
    pub timeline_start_secs: f64,
    pub in_point_secs: f64,
    pub out_point_secs: f64,
    pub volume: f32,
    pub is_muted: bool,
    #[serde(default)]
    pub scale: Option<f32>,
    #[serde(default)]
    pub position_x: Option<f32>,
    #[serde(default)]
    pub position_y: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AudioTrackData {
    pub id: String,
    pub asset_id: String,
    pub source_path: String,
    pub name: String,
    pub timeline_start_secs: f64,
    pub in_point_secs: f64,
    pub duration_secs: f64,
    pub volume: f32,
    pub is_muted: bool,
    pub fade_in_secs: f64,
    pub fade_out_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct RavixProjectData {
    pub version: String,
    pub name: String,
    pub assets: Vec<MediaAssetInfo>,
    pub video_clips: Vec<TimelineClipData>,
    pub music_tracks: Vec<AudioTrackData>,
    pub framing_mode: String,
    pub resolution_mode: String,
    pub fps: u32,
    pub bitrate_kbps: u32,
}
