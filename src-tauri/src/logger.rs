use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

const MAX_LOG_BYTES: u64 = 1024 * 1024; // 1 MB máximo por arquivo

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock() -> &'static Mutex<()> {
    LOG_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn log_file_path() -> PathBuf {
    let base = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("RAVIX")
        .join("logs");
    let _ = fs::create_dir_all(&base);
    base.join("ravix.log")
}

fn rotate_if_needed(path: &PathBuf) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= MAX_LOG_BYTES {
            let backup = path.with_extension("log.1");
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(path, backup);
        }
    }
}

pub fn write_log(level: &str, component: &str, message: &str) {
    let _guard = lock().lock();
    let path = log_file_path();
    rotate_if_needed(&path);

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{ts}] [{level}] [{component}] {message}");
    }
}

pub fn info(component: &str, message: &str) {
    write_log("INFO", component, message);
}

pub fn warn(component: &str, message: &str) {
    write_log("WARN", component, message);
}

pub fn error(component: &str, message: &str) {
    write_log("ERROR", component, message);
}

pub fn init_logging() {
    // Cria o arquivo inicial se não existir e instala panic hook persistente
    let path = log_file_path();
    if !path.exists() {
        let _ = File::create(&path);
    }

    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "local desconhecido".to_string());
        let payload = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "payload não textual".to_string()
        };
        write_log("FATAL", "panic", &format!("Panic em {location}: {payload}"));
        prev_hook(panic_info);
    }));

    info("startup", &format!("RAVIX v{} iniciando...", env!("CARGO_PKG_VERSION")));
}
