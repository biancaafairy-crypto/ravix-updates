mod audio;
mod capabilities;
mod config;
mod d3d11;
mod editor;
mod geometry;
mod logger;
mod models;
mod recorder;
mod sink;
mod wgc;

use crate::capabilities::{collect_capabilities, get_free_disk_bytes};
use crate::config::{list_recordings, load_config, save_config};
use crate::models::{RecordedFileInfo, RecorderStatus, RecordingConfig, SystemCapabilities};
use crate::recorder::RecorderManager;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    config: Arc<Mutex<RecordingConfig>>,
    recorder: Arc<RecorderManager>,
}

const TRAY_ID: &str = "ravix-tray";

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn update_tray_visual(app: &AppHandle, state: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let is_rec = state == "recording" || state == "starting";
        let bytes: &[u8] = if is_rec {
            include_bytes!("../icons/tray-rec.png")
        } else {
            include_bytes!("../icons/tray-idle.png")
        };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = tray.set_icon(Some(img));
        }
        let tip = if is_rec {
            "RAVIX — Gravando gameplay"
        } else {
            "RAVIX — Pronto para gravar"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn start_with_arcs(
    config: &Arc<Mutex<RecordingConfig>>,
    recorder: &Arc<RecorderManager>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut cfg = config.lock().clone();
    let caps = collect_capabilities(cfg.output_dir.clone());

    if cfg.source_kind == "monitor" {
        if !caps.sources.iter().any(|s| s.kind == "monitor" && s.id == cfg.source_id) {
            // Tentar localizar por process_name (ex: \\.\DISPLAY2) ou fallback para o monitor correspondente
            if let Some(matching) = caps.sources.iter().find(|s| s.kind == "monitor" && (s.process_name == cfg.source_id || s.title.contains(&cfg.source_id))) {
                cfg.source_id = matching.id.clone();
            } else if let Some(first_mon) = caps.sources.iter().find(|s| s.kind == "monitor") {
                cfg.source_id = first_mon.id.clone();
            }
        }
    } else if cfg.source_id.is_empty() {
        if let Some(first) = caps.sources.first() {
            cfg.source_kind = first.kind.clone();
            cfg.source_id = first.id.clone();
        }
    }

    let encoder_name = if let Some(enc) = caps.encoders.iter().find(|e| e.id == cfg.encoder_id) {
        enc.name.clone()
    } else if let Some(first_enc) = caps.encoders.first() {
        cfg.encoder_id = first_enc.id.clone();
        first_enc.name.clone()
    } else {
        "Microsoft Media Foundation H.264".to_string()
    };

    *config.lock() = cfg.clone();
    let _ = save_config(&cfg);
    logger::info(
        "recorder",
        &format!(
            "Iniciando gravação: fonte={}:{}, fps={}, bitrate={}kbps, encoder={}",
            cfg.source_kind, cfg.source_id, cfg.fps, cfg.bitrate_kbps, encoder_name
        ),
    );
    match recorder.start(cfg, app.clone(), encoder_name) {
        Ok(()) => Ok(()),
        Err(e) => {
            logger::error("recorder", &format!("Falha ao iniciar gravação: {e}"));
            Err(e)
        }
    }
}

#[tauri::command]
async fn get_system_capabilities(state: State<'_, AppState>) -> Result<SystemCapabilities, String> {
    let out_dir = state.config.lock().output_dir.clone();
    tauri::async_runtime::spawn_blocking(move || collect_capabilities(out_dir))
        .await
        .map_err(|e| format!("Falha ao consultar capacidades: {e}"))
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> RecordingConfig {
    state.config.lock().clone()
}

#[tauri::command]
fn save_user_config(config: RecordingConfig, state: State<'_, AppState>) -> Result<RecordingConfig, String> {
    save_config(&config)?;
    *state.config.lock() = config.clone();
    Ok(config)
}

#[tauri::command]
fn get_recorder_status(state: State<'_, AppState>) -> RecorderStatus {
    let mut st = state.recorder.get_status();
    if st.state == "idle" || st.state == "error" {
        let out_dir = state.config.lock().output_dir.clone();
        if let Some(bytes) = get_free_disk_bytes(&out_dir) {
            st.free_disk_gb = ((bytes as f64 / (1024.0 * 1024.0 * 1024.0)) * 100.0).round() / 100.0;
        }
    }
    st
}

#[tauri::command]
async fn start_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.clone();
    let recorder = state.recorder.clone();
    tauri::async_runtime::spawn_blocking(move || start_with_arcs(&config, &recorder, &app))
        .await
        .map_err(|e| format!("Falha interna ao iniciar gravação: {e}"))?
}

#[tauri::command]
async fn stop_recording(state: State<'_, AppState>) -> Result<(), String> {
    let recorder = state.recorder.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recorder.stop();
    })
    .await
    .map_err(|e| format!("Falha interna ao parar gravação: {e}"))
}

#[tauri::command]
async fn toggle_recording(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let config = state.config.clone();
    let recorder = state.recorder.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if recorder.is_recording() {
            recorder.stop();
            Ok(false)
        } else {
            start_with_arcs(&config, &recorder, &app)?;
            Ok(true)
        }
    })
    .await
    .map_err(|e| format!("Falha interna ao alternar gravação: {e}"))?
}

#[tauri::command]
fn list_recorded_files(state: State<'_, AppState>) -> Vec<RecordedFileInfo> {
    let out_dir = state.config.lock().output_dir.clone();
    list_recordings(&out_dir)
}

#[tauri::command]
fn open_recordings_folder(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let out_dir = state.config.lock().output_dir.clone();
    let _ = std::fs::create_dir_all(&out_dir);
    app.opener()
        .open_path(out_dir, None::<&str>)
        .map_err(|e| format!("Não foi possível abrir pasta: {e}"))
}

#[tauri::command]
fn open_video_file(path: String, app: AppHandle) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Arquivo não encontrado no disco.".to_string());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Não foi possível abrir vídeo: {e}"))
}

#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Arquivo não encontrado no disco.".to_string());
    }
    let full_path = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,\"{}\"", full_path.display()))
        .spawn()
        .map_err(|e| format!("Não foi possível abrir pasta do arquivo: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_default_video_dir() -> String {
    crate::config::get_default_user_video_dir()
}

fn validate_hotkey_string(hotkey: &str) -> Result<String, String> {
    let trimmed = hotkey.trim();
    if trimmed.is_empty() {
        return Err("O atalho não pode ficar vazio.".to_string());
    }

    let upper = trimmed.to_uppercase();
    let f_keys = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
    if f_keys.contains(&upper.as_str()) {
        return Ok(upper);
    }

    if trimmed.contains('+') {
        let parts: Vec<&str> = trimmed.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if parts.len() < 2 {
            return Err("Combinação de atalho incompleta.".to_string());
        }
        let has_modifier = parts.iter().take(parts.len() - 1).any(|p| {
            let p_lower = p.to_lowercase();
            matches!(p_lower.as_str(), "ctrl" | "control" | "alt" | "shift" | "commandorcontrol" | "cmd" | "super" | "win")
        });
        if !has_modifier {
            return Err("A combinação deve incluir ao menos um modificador (Ctrl, Alt ou Shift).".to_string());
        }
        return Ok(trimmed.to_string());
    }

    Err("Letras e números isolados não são permitidos como atalho global. Use F1-F12 ou combine com Ctrl, Alt ou Shift.".to_string())
}

#[tauri::command]
fn suspend_hotkey(app: AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    Ok(())
}

#[tauri::command]
fn resume_hotkey(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let hotkey = state.config.lock().hotkey.clone();
    register_global_hotkey(&app, &hotkey)
}

#[tauri::command]
fn update_hotkey(hotkey: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let validated = validate_hotkey_string(&hotkey)?;
    register_global_hotkey(&app, &validated)?;
    let mut cfg = state.config.lock();
    cfg.hotkey = validated;
    save_config(&cfg)?;
    Ok(())
}

#[tauri::command]
async fn get_video_metadata(path: String) -> Result<crate::models::VideoMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || crate::editor::get_video_metadata(&path))
        .await
        .map_err(|e| format!("Falha interna ao obter metadados: {e}"))?
}

#[tauri::command]
async fn start_video_export(config: crate::models::ExportConfig, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::editor::run_export(config, app))
        .await
        .map_err(|e| format!("Falha interna na exportação: {e}"))?
}

#[tauri::command]
fn cancel_video_export() {
    crate::editor::cancel_current_export();
}

#[tauri::command]
fn get_media_metadata(path: String) -> Result<crate::models::MediaAssetInfo, String> {
    crate::editor::get_media_metadata(&path)
}

#[tauri::command]
async fn start_timeline_export(config: crate::models::TimelineExportConfig, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::editor::run_timeline_export(config, app))
        .await
        .map_err(|e| format!("Falha interna na exportação da timeline: {e}"))?
}

#[tauri::command]
fn cancel_timeline_export() {
    crate::editor::cancel_current_export();
}

#[tauri::command]
fn save_ravix_project(path: String, project_json: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(p, project_json).map_err(|e| format!("Falha ao salvar projeto: {e}"))
}

#[tauri::command]
fn load_ravix_project(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Falha ao carregar projeto: {e}"))
}

#[tauri::command]
fn check_media_files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.into_iter().map(|p| std::path::Path::new(&p).exists()).collect()
}

fn spawn_toggle_from_handle(app_h: &AppHandle) {
    let state = app_h.state::<AppState>();
    let config = state.config.clone();
    let recorder = state.recorder.clone();
    let app = app_h.clone();
    std::thread::spawn(move || {
        if recorder.is_recording() {
            recorder.stop();
        } else {
            let _ = start_with_arcs(&config, &recorder, &app);
        }
    });
}

fn register_global_hotkey(app: &AppHandle, shortcut_str: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.on_shortcut(shortcut_str, |app_handle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            spawn_toggle_from_handle(app_handle);
        }
    })
    .map_err(|e| format!("Atalho inválido ou em uso ('{shortcut_str}'): {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init_logging();

    let mut initial_cfg = load_config();
    logger::info("startup", "Configuração carregada.");

    let caps = collect_capabilities(initial_cfg.output_dir.clone());
    logger::info(
        "startup",
        &format!(
            "Capacidades detectadas: {} fontes, {} encoders, {} saídas de áudio, {} microfones.",
            caps.sources.len(),
            caps.encoders.len(),
            caps.render_devices.len(),
            caps.capture_devices.len()
        ),
    );

    if initial_cfg.source_kind == "monitor" {
        if !caps.sources.iter().any(|s| s.kind == "monitor" && s.id == initial_cfg.source_id) {
            if let Some(matching) = caps.sources.iter().find(|s| s.kind == "monitor" && (s.process_name == initial_cfg.source_id || s.title.contains(&initial_cfg.source_id))) {
                initial_cfg.source_id = matching.id.clone();
            } else if let Some(first_mon) = caps.sources.iter().find(|s| s.kind == "monitor") {
                initial_cfg.source_id = first_mon.id.clone();
            }
        }
    } else if initial_cfg.source_id.is_empty() {
        if let Some(first) = caps.sources.first() {
            initial_cfg.source_kind = first.kind.clone();
            initial_cfg.source_id = first.id.clone();
        }
    }
    if initial_cfg.encoder_id.is_empty()
        || !caps.encoders.iter().any(|e| e.id == initial_cfg.encoder_id)
    {
        if let Some(first_hw) = caps.encoders.iter().find(|e| e.is_hardware) {
            initial_cfg.encoder_id = first_hw.id.clone();
        } else if let Some(first_any) = caps.encoders.first() {
            initial_cfg.encoder_id = first_any.id.clone();
        }
    }
    if let Err(e) = save_config(&initial_cfg) {
        logger::warn("startup", &format!("Não foi possível salvar config inicial: {e}"));
    }

    let config_arc = Arc::new(Mutex::new(initial_cfg.clone()));

    let run_res = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            logger::info("startup", "Executando setup da interface Tauri...");
            let app_handle = app.handle().clone();
            let app_for_tray = app_handle.clone();

            let recorder = Arc::new(RecorderManager::new(move |new_state| {
                update_tray_visual(&app_for_tray, new_state);
            }));

            app.manage(AppState {
                config: config_arc.clone(),
                recorder: recorder.clone(),
            });

            // Configurar System Tray (tratando erro de forma não fatal para não impedir abertura da UI)
            let tray_setup = (|| -> Result<(), Box<dyn std::error::Error>> {
                let open_i = MenuItem::with_id(app, "open", "Abrir RAVIX", true, None::<&str>)?;
                let toggle_i =
                    MenuItem::with_id(app, "toggle", "Iniciar / Parar Gravação", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Sair do RAVIX", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_i, &toggle_i, &quit_i])?;

                let icon = Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?;

                TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon)
                    .tooltip("RAVIX — Pronto para gravar")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app_h, event| match event.id.as_ref() {
                        "open" => show_main_window(app_h),
                        "toggle" => spawn_toggle_from_handle(app_h),
                        "quit" => {
                            logger::info("lifecycle", "Encerramento solicitado pela bandeja.");
                            let st = app_h.state::<AppState>();
                            st.recorder.stop();
                            app_h.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
                Ok(())
            })();

            match tray_setup {
                Ok(()) => logger::info("startup", "Bandeja do Windows criada."),
                Err(e) => logger::warn("startup", &format!("Falha não fatal ao criar bandeja: {e}")),
            }

            if let Err(e) = register_global_hotkey(&app_handle, &initial_cfg.hotkey) {
                logger::warn("startup", &format!("Atalho global '{}' não registrado: {e}", initial_cfg.hotkey));
            } else {
                logger::info("startup", &format!("Atalho global '{}' registrado.", initial_cfg.hotkey));
            }

            logger::info("startup", "Setup Tauri concluído; janela principal pronta.");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let st = window.app_handle().state::<AppState>();
                let keep_in_tray = st.config.lock().minimize_to_tray_on_close || st.recorder.is_recording();
                if keep_in_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    logger::info("lifecycle", "Janela fechada; encerrando aplicativo.");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_default_video_dir,
            get_system_capabilities,
            get_config,
            save_user_config,
            get_recorder_status,
            start_recording,
            stop_recording,
            toggle_recording,
            list_recorded_files,
            open_recordings_folder,
            open_video_file,
            open_file_location,
            update_hotkey,
            suspend_hotkey,
            resume_hotkey,
            get_video_metadata,
            start_video_export,
            cancel_video_export,
            get_media_metadata,
            start_timeline_export,
            cancel_timeline_export,
            save_ravix_project,
            load_ravix_project,
            check_media_files_exist,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = run_res {
        logger::error("startup", &format!("Erro fatal na runtime Tauri: {e}"));
        std::process::exit(1);
    }
}
