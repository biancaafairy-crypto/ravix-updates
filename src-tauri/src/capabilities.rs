use crate::models::{AudioDeviceOption, CaptureSource, EncoderOption, SystemCapabilities};
use std::collections::HashSet;
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, MFShutdown, MFStartup, MFTEnumEx, MFVideoFormat_H264, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_ASYNCMFT, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_ENUM_FLAG_SYNCMFT, MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MF_VERSION,
};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

// PKEY_Device_FriendlyName: {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

pub fn get_free_disk_bytes(path: &str) -> Option<u64> {
    let mut check_path = Path::new(path);
    while !check_path.exists() {
        match check_path.parent() {
            Some(p) => check_path = p,
            None => break,
        }
    }
    let wide: Vec<u16> = check_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_bytes: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_bytes),
            None,
            None,
        )
    };
    if ok.is_ok() {
        Some(free_bytes)
    } else {
        None
    }
}

pub fn collect_capabilities(default_output_dir: String) -> SystemCapabilities {
    let mut sources = enumerate_monitors();
    let windows = enumerate_windows();
    sources.extend(windows);

    // Ordenar colocando jogos prioritários (FiveM / GTA V) no topo, depois monitores, depois outras janelas
    sources.sort_by(|a, b| {
        b.is_game_priority
            .cmp(&a.is_game_priority)
            .then_with(|| {
                let a_mon = a.kind == "monitor";
                let b_mon = b.kind == "monitor";
                b_mon.cmp(&a_mon)
            })
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    let max_hz = sources
        .iter()
        .filter(|s| s.kind == "monitor")
        .map(|s| s.refresh_hz)
        .max()
        .unwrap_or(60);

    let mut supported_fps = vec![30, 60];
    if max_hz >= 120 {
        supported_fps.push(120);
    }

    let encoders = enumerate_h264_encoders();
    let (render_devices, capture_devices) = enumerate_audio_devices();

    SystemCapabilities {
        sources,
        encoders,
        render_devices,
        capture_devices,
        supported_fps,
        default_output_dir,
    }
}

fn enumerate_monitors() -> Vec<CaptureSource> {
    unsafe extern "system" fn monitor_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<CaptureSource>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
            let rect = info.monitorInfo.rcMonitor;
            let width = (rect.right - rect.left).max(0) as u32;
            let height = (rect.bottom - rect.top).max(0) as u32;

            let dev_name_len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let dev_name = OsString::from_wide(&info.szDevice[..dev_name_len])
                .to_string_lossy()
                .to_string();

            let mut devmode = DEVMODEW::default();
            devmode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            let mut refresh_hz = 60u32;
            if EnumDisplaySettingsW(
                PCWSTR(info.szDevice.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut devmode,
            )
            .as_bool()
                && devmode.dmDisplayFrequency > 1
            {
                refresh_hz = devmode.dmDisplayFrequency;
            }

            let is_primary = (info.monitorInfo.dwFlags & 1) != 0;
            let label = if is_primary {
                format!("Monitor Principal ({width}x{height} @ {refresh_hz}Hz)")
            } else {
                format!("Monitor {} ({width}x{height} @ {refresh_hz}Hz)", list.len() + 1)
            };

            list.push(CaptureSource {
                id: (hmon.0 as isize).to_string(),
                kind: "monitor".to_string(),
                title: label,
                process_name: dev_name,
                width,
                height,
                refresh_hz,
                is_game_priority: false,
            });
        }
        BOOL(1)
    }

    let mut monitors: Vec<CaptureSource> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    monitors
}

fn enumerate_windows() -> Vec<CaptureSource> {
    struct EnumCtx {
        self_pid: u32,
        items: Vec<CaptureSource>,
    }

    unsafe extern "system" fn window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumCtx);

        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
            return BOOL(1);
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return BOOL(1);
        }

        let mut title_buf = vec![0u16; (title_len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        if copied <= 0 {
            return BOOL(1);
        }
        let title = OsString::from_wide(&title_buf[..copied as usize])
            .to_string_lossy()
            .trim()
            .to_string();
        if title.is_empty() {
            return BOOL(1);
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        if width < 200 || height < 150 {
            return BOOL(1);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == ctx.self_pid {
            return BOOL(1);
        }

        let process_name = get_process_name(pid).unwrap_or_else(|| "app.exe".to_string());
        let proc_lower = process_name.to_ascii_lowercase();
        let title_lower = title.to_ascii_lowercase();

        // Ignorar janelas internas de shell do Windows que não fazem sentido para gameplay
        if matches!(
            proc_lower.as_str(),
            "textinputhost.exe" | "shellexperiencehost.exe" | "systemsettings.exe"
        ) {
            return BOOL(1);
        }

        let is_game_priority = proc_lower.contains("fivem")
            || proc_lower.contains("gta5")
            || title_lower.contains("fivem")
            || title_lower.contains("grand theft auto v");

        ctx.items.push(CaptureSource {
            id: (hwnd.0 as isize).to_string(),
            kind: "window".to_string(),
            title,
            process_name,
            width,
            height,
            refresh_hz: 60,
            is_game_priority,
        });

        BOOL(1)
    }

    let mut ctx = EnumCtx {
        self_pid: unsafe { GetCurrentProcessId() },
        items: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(window_proc), LPARAM(&mut ctx as *mut _ as isize));
    }
    ctx.items
}

fn get_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if ok.is_ok() && len > 0 {
            let full = OsString::from_wide(&buf[..len as usize])
                .to_string_lossy()
                .to_string();
            return Path::new(&full)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string());
        }
    }
    None
}

fn enumerate_h264_encoders() -> Vec<EncoderOption> {
    // Executa em thread dedicada para nunca alterar o COM Apartment (STA) da thread principal da UI
    std::thread::Builder::new()
        .name("ravix-enum-enc".to_string())
        .spawn(|| enumerate_h264_encoders_mta())
        .ok()
        .and_then(|h| h.join().ok())
        .unwrap_or_default()
}

fn enumerate_h264_encoders_mta() -> Vec<EncoderOption> {
    unsafe {
        let com_init = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let mf_ok = MFStartup(MF_VERSION, 0).is_ok();
        let mut result = Vec::new();
        let mut seen_names = HashSet::new();

        let out_type = MFT_REGISTER_TYPE_INFO {
            guidMajorType: windows::Win32::Media::MediaFoundation::MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };

        // 1. Hardware encoders primeiro
        let mut pp_activate: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count: u32 = 0;
        let hr_hw = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&out_type),
            &mut pp_activate,
            &mut count,
        );

        if hr_hw.is_ok() && !pp_activate.is_null() {
            let slice = std::slice::from_raw_parts(pp_activate, count as usize);
            for (idx, act_opt) in slice.iter().enumerate() {
                if let Some(act) = act_opt {
                    let name = get_mft_friendly_name(act)
                        .unwrap_or_else(|| format!("Hardware H.264 Encoder #{}", idx + 1));
                    if seen_names.insert(name.clone()) {
                        let vendor = detect_vendor(&name);
                        result.push(EncoderOption {
                            id: format!("hw:{name}"),
                            name,
                            vendor,
                            codec: "H264".to_string(),
                            is_hardware: true,
                        });
                    }
                }
            }
            CoTaskMemFree(Some(pp_activate as *const _));
        }

        // 2. Software fallback (Microsoft H264 Video Encoder MFT) caso não haja hardware ou para backup
        let mut pp_sw: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut sw_count: u32 = 0;
        let hr_sw = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&out_type),
            &mut pp_sw,
            &mut sw_count,
        );

        if hr_sw.is_ok() && !pp_sw.is_null() {
            let slice = std::slice::from_raw_parts(pp_sw, sw_count as usize);
            for act_opt in slice.iter() {
                if let Some(act) = act_opt {
                    if let Some(name) = get_mft_friendly_name(act) {
                        if seen_names.insert(name.clone()) {
                            let lower = name.to_ascii_lowercase();
                            let is_hw = lower.contains("amd")
                                || lower.contains("nvidia")
                                || lower.contains("nvenc")
                                || lower.contains("intel")
                                || lower.contains("qsv");
                            let vendor = detect_vendor(&name);
                            result.push(EncoderOption {
                                id: if is_hw {
                                    format!("hw:{name}")
                                } else {
                                    format!("sw:{name}")
                                },
                                name,
                                vendor,
                                codec: "H264".to_string(),
                                is_hardware: is_hw,
                            });
                        }
                    }
                }
            }
            CoTaskMemFree(Some(pp_sw as *const _));
        }

        if mf_ok {
            let _ = MFShutdown();
        }
        if com_init {
            CoUninitialize();
        }
        result
    }
}

unsafe fn get_mft_friendly_name(act: &IMFActivate) -> Option<String> {
    let mut pwstr = PWSTR::null();
    let mut len = 0u32;
    act.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
        .ok()?;
    let s = pwstr.to_string().ok();
    CoTaskMemFree(Some(pwstr.0 as *const _));
    s
}

fn detect_vendor(name: &str) -> String {
    let l = name.to_ascii_lowercase();
    if l.contains("amd") || l.contains("radeon") || l.contains("amf") {
        "AMD".to_string()
    } else if l.contains("nvidia") || l.contains("nvenc") {
        "NVIDIA".to_string()
    } else if l.contains("intel") || l.contains("quick sync") || l.contains("qsv") {
        "Intel".to_string()
    } else {
        "Software".to_string()
    }
}

fn enumerate_audio_devices() -> (Vec<AudioDeviceOption>, Vec<AudioDeviceOption>) {
    // Executa em thread dedicada para manter a thread principal em STA (OleInitialize / WebView2)
    std::thread::Builder::new()
        .name("ravix-enum-audio".to_string())
        .spawn(|| enumerate_audio_devices_mta())
        .ok()
        .and_then(|h| h.join().ok())
        .unwrap_or_default()
}

fn enumerate_audio_devices_mta() -> (Vec<AudioDeviceOption>, Vec<AudioDeviceOption>) {
    unsafe {
        let com_init = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let res = match CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(enumerator) => {
                let render = list_endpoints(&enumerator, eRender, "render");
                let capture = list_endpoints(&enumerator, eCapture, "capture");
                (render, capture)
            }
            Err(_) => (Vec::new(), Vec::new()),
        };
        if com_init {
            CoUninitialize();
        }
        res
    }
}

unsafe fn list_endpoints(
    enumerator: &IMMDeviceEnumerator,
    data_flow: windows::Win32::Media::Audio::EDataFlow,
    kind: &str,
) -> Vec<AudioDeviceOption> {
    let default_id = enumerator
        .GetDefaultAudioEndpoint(data_flow, eConsole)
        .ok()
        .and_then(|d| get_device_id(&d));

    let Ok(collection) = enumerator.EnumAudioEndpoints(data_flow, DEVICE_STATE_ACTIVE) else {
        return Vec::new();
    };
    let count = collection.GetCount().unwrap_or(0);
    let mut out = Vec::new();

    for i in 0..count {
        if let Ok(dev) = collection.Item(i) {
            if let Some(id) = get_device_id(&dev) {
                let name = get_device_friendly_name(&dev).unwrap_or_else(|| format!("Dispositivo {}", i + 1));
                let is_default = default_id.as_ref().map(|d| d == &id).unwrap_or(false);
                out.push(AudioDeviceOption {
                    id,
                    name,
                    is_default,
                    kind: kind.to_string(),
                });
            }
        }
    }

    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.cmp(&b.name)));
    out
}

unsafe fn get_device_id(dev: &IMMDevice) -> Option<String> {
    let pwstr = dev.GetId().ok()?;
    let s = pwstr.to_string().ok();
    CoTaskMemFree(Some(pwstr.0 as *const _));
    s
}

unsafe fn get_device_friendly_name(dev: &IMMDevice) -> Option<String> {
    let store = dev.OpenPropertyStore(STGM_READ).ok()?;
    let prop = store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok()?;
    let text = prop.to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}
