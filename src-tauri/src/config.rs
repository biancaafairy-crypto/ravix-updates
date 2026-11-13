use crate::models::{RecordedFileInfo, RecordingConfig};
use std::fs;
use std::path::{Path, PathBuf};

fn config_file_path() -> PathBuf {
    let base = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("RAVIX");
    let _ = fs::create_dir_all(&base);
    base.join("config.json")
}

pub fn get_default_user_video_dir() -> String {
    dirs::video_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\")))
        .join("RAVIX")
        .to_string_lossy()
        .to_string()
}

pub fn load_config() -> RecordingConfig {
    let path = config_file_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut cfg) = serde_json::from_str::<RecordingConfig>(&content) {
            // Auto-cura de caminhos herdados do ambiente de desenvolvimento (Etapa 13):
            // Se o caminho salvo contém "Santarosa" e o diretório real do usuário atual for diferente,
            // ou se a pasta não existir no disco, migra automaticamente para o diretório de Vídeos do usuário ativo.
            let current_user_video_dir = get_default_user_video_dir();
            if cfg.output_dir.contains("Santarosa") && !current_user_video_dir.contains("Santarosa") {
                cfg.output_dir = current_user_video_dir;
                let _ = save_config(&cfg);
            }
            return cfg;
        }
    }
    let default_cfg = RecordingConfig::default();
    let _ = save_config(&default_cfg);
    default_cfg
}

pub fn save_config(cfg: &RecordingConfig) -> Result<(), String> {
    let path = config_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Falha ao criar pasta de config: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Falha ao serializar config: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Falha ao salvar config: {e}"))?;
    Ok(())
}

pub fn list_recordings(output_dir: &str) -> Vec<RecordedFileInfo> {
    let dir = Path::new(output_dir);
    if !dir.exists() {
        return Vec::new();
    }

    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            if ext != "mp4" && ext != "mkv" {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let modified_ts = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                items.push(RecordedFileInfo {
                    path: path.to_string_lossy().to_string(),
                    filename: path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("video")
                        .to_string(),
                    size_bytes: meta.len(),
                    modified_ts,
                });
            }
        }
    }
    items.sort_by(|a, b| b.modified_ts.cmp(&a.modified_ts));
    items
}

pub fn build_unique_recording_path(output_dir: &str, segment_idx: u32) -> Result<PathBuf, String> {
    let dir = Path::new(output_dir);
    fs::create_dir_all(dir).map_err(|e| format!("Não foi possível criar pasta '{output_dir}': {e}"))?;

    let now = chrono::Local::now();
    let stamp = now.format("%Y-%m-%d_%H-%M-%S").to_string();

    for attempt in 0..1000u32 {
        let filename = if segment_idx <= 1 && attempt == 0 {
            format!("RAVIX_{stamp}.mp4")
        } else if attempt == 0 {
            format!("RAVIX_{stamp}_part{segment_idx:02}.mp4")
        } else {
            format!("RAVIX_{stamp}_part{segment_idx:02}_{attempt}.mp4")
        };
        let candidate = dir.join(filename);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Não foi possível gerar um nome de arquivo único.".to_string())
}
