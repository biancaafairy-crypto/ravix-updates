use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use windows::core::Interface;
use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

struct SendSync<T>(T);
unsafe impl<T> Send for SendSync<T> {}
unsafe impl<T> Sync for SendSync<T> {}

pub struct LatestCaptureSlot {
    pending_frame: Mutex<Option<SendSync<Direct3D11CaptureFrame>>>,
    pub sequence: AtomicU64,
    pub item_closed: AtomicBool,
}

unsafe impl Send for LatestCaptureSlot {}
unsafe impl Sync for LatestCaptureSlot {}

pub struct WgcSession {
    item: GraphicsCaptureItem,
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrived_token: EventRegistrationToken,
    closed_token: EventRegistrationToken,
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
    cached_tex: Option<(ID3D11Texture2D, u32, u32)>,
    pub initial_width: u32,
    pub initial_height: u32,
    pub slot: Arc<LatestCaptureSlot>,
}

fn resolve_hmonitor(source_id: &str) -> Result<HMONITOR, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, MONITORINFOEXW};

    // 1. Se foi passado um identificador numérico, validar se o HMONITOR ainda existe e está ativo no sistema
    if let Ok(raw) = source_id.trim().parse::<isize>() {
        let candidate = HMONITOR(raw as *mut core::ffi::c_void);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(candidate, &mut info as *mut _ as *mut _).as_bool() } {
            return Ok(candidate);
        }
    }

    // 2. Se o HMONITOR salvo na sessão anterior não é mais válido (ou se foi passado nome de dispositivo "\\.\DISPLAY2"),
    // enumerar monitores ativos e localizar pelo szDevice ("\\.\DISPLAY1", "\\.\DISPLAY2") ou índice
    struct SearchCtx {
        target: String,
        found: Option<HMONITOR>,
        fallback: Option<HMONITOR>,
        all_monitors: Vec<HMONITOR>,
    }
    let mut ctx = SearchCtx {
        target: source_id.trim().to_string(),
        found: None,
        fallback: None,
        all_monitors: Vec::new(),
    };

    unsafe extern "system" fn search_proc(hmon: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut SearchCtx);
        ctx.all_monitors.push(hmon);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info as *mut _ as *mut _).as_bool() {
            let is_primary = (info.monitorInfo.dwFlags & 1) != 0;
            if is_primary || ctx.fallback.is_none() {
                ctx.fallback = Some(hmon);
            }
            let dev_name_len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
            let dev_name = OsString::from_wide(&info.szDevice[..dev_name_len]).to_string_lossy().to_string();
            // Comparar com target (ex: "\\.\DISPLAY2" ou "DISPLAY2")
            if !ctx.target.is_empty() && (dev_name.eq_ignore_ascii_case(&ctx.target) || ctx.target.contains(&dev_name)) {
                ctx.found = Some(hmon);
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(search_proc), LPARAM(&mut ctx as *mut _ as isize));
    }

    if let Some(h) = ctx.found {
        return Ok(h);
    }

    // 3. Se target menciona "Monitor 2" ou "2" ou "DISPLAY2", tentar o segundo monitor da lista
    if (ctx.target.contains("2") || ctx.target.contains("DISPLAY2")) && ctx.all_monitors.len() >= 2 {
        return Ok(ctx.all_monitors[1]);
    }

    // 4. Fallback seguro: primeiro monitor disponível / principal
    if let Some(h) = ctx.fallback.or_else(|| ctx.all_monitors.first().copied()) {
        Ok(h)
    } else {
        Err(format!("Nenhum monitor ativo encontrado para o identificador '{source_id}'."))
    }
}

impl WgcSession {
    pub fn start(
        d3d_device: ID3D11Device,
        d3d_context: ID3D11DeviceContext,
        winrt_device: &IDirect3DDevice,
        source_kind: &str,
        source_id: &str,
    ) -> Result<Self, String> {
        unsafe {
            let interop: IGraphicsCaptureItemInterop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(|e| format!("WGC não disponível neste Windows: {e}"))?;

            let item: GraphicsCaptureItem = if source_kind == "window" {
                let raw_handle: isize = source_id
                    .trim()
                    .parse()
                    .map_err(|_| format!("ID de fonte inválido: '{source_id}'"))?;
                interop
                    .CreateForWindow(HWND(raw_handle as *mut core::ffi::c_void))
                    .map_err(|e| format!("Não foi possível capturar a janela selecionada: {e}"))?
            } else {
                let hmon = resolve_hmonitor(source_id)?;
                interop
                    .CreateForMonitor(hmon)
                    .map_err(|e| format!("Não foi possível capturar o monitor selecionado: {e}"))?
            };

            let size = item
                .Size()
                .map_err(|e| format!("Falha ao obter dimensões da fonte WGC: {e}"))?;
            if size.Width <= 0 || size.Height <= 0 {
                return Err("Fonte de captura possui dimensões inválidas (minimizada ou fechada).".to_string());
            }

            let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                winrt_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )
            .map_err(|e| format!("Falha ao criar Direct3D11CaptureFramePool: {e}"))?;

            let session = frame_pool
                .CreateCaptureSession(&item)
                .map_err(|e| format!("Falha ao criar GraphicsCaptureSession: {e}"))?;

            // Remover borda amarela quando suportado pelo Windows 10 2004+ / 11
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetIsCursorCaptureEnabled(true);

            let slot = Arc::new(LatestCaptureSlot {
                pending_frame: Mutex::new(None),
                sequence: AtomicU64::new(0),
                item_closed: AtomicBool::new(false),
            });

            // Evento de fechamento da janela/fonte
            let slot_closed = slot.clone();
            let closed_token = item
                .Closed(&TypedEventHandler::<GraphicsCaptureItem, windows::core::IInspectable>::new(move |_, _| {
                    slot_closed.item_closed.store(true, Ordering::SeqCst);
                    Ok(())
                }))
                .map_err(|e| format!("Falha ao registrar item.Closed: {e}"))?;

            // Evento FrameArrived: não toca em d3d_context para evitar contenção/deadlock multithread
            let last_size = Arc::new(Mutex::new(size));
            let slot_frame = slot.clone();
            let pool_wrap = SendSync(frame_pool.clone());
            let dev_wrap = SendSync(winrt_device.clone());

            let arrived_token = frame_pool
                .FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |sender, _| {
                    let _keep = (&pool_wrap, &dev_wrap);
                    let pool_for_cb = &pool_wrap.0;
                    let dev_for_cb = &dev_wrap.0;
                    let Some(pool) = sender.as_ref() else {
                        return Ok(());
                    };
                    let Ok(frame) = pool.TryGetNextFrame() else {
                        return Ok(());
                    };

                    if let Ok(content_size) = frame.ContentSize() {
                        let mut ls = last_size.lock();
                        if content_size.Width > 0
                            && content_size.Height > 0
                            && (content_size.Width != ls.Width || content_size.Height != ls.Height)
                        {
                            *ls = content_size;
                            let _ = pool_for_cb.Recreate(
                                dev_for_cb,
                                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                                2,
                                content_size,
                            );
                        }
                    }

                    let old = {
                        let mut guard = slot_frame.pending_frame.lock();
                        guard.replace(SendSync(frame))
                    };
                    if let Some(SendSync(prev)) = old {
                        let _ = prev.Close();
                    }
                    slot_frame.sequence.fetch_add(1, Ordering::Release);
                    Ok(())
                }))
                .map_err(|e| format!("Falha ao registrar FrameArrived: {e}"))?;

            session
                .StartCapture()
                .map_err(|e| format!("Falha ao iniciar captura WGC: {e}"))?;

            Ok(Self {
                item,
                frame_pool,
                session,
                arrived_token,
                closed_token,
                d3d_device,
                d3d_context,
                cached_tex: None,
                initial_width: size.Width as u32,
                initial_height: size.Height as u32,
                slot,
            })
        }
    }

    pub fn acquire_latest_texture(&mut self) -> Option<(ID3D11Texture2D, u32, u32, bool)> {
        let frame_opt = self.slot.pending_frame.lock().take();
        let mut is_new = false;
        if let Some(SendSync(frame)) = frame_opt {
            unsafe {
                if let Ok(surface) = frame.Surface() {
                    if let Ok(access) = surface.cast::<IDirect3DDxgiInterfaceAccess>() {
                        if let Ok(src_tex) = access.GetInterface::<ID3D11Texture2D>() {
                            let mut desc = D3D11_TEXTURE2D_DESC::default();
                            src_tex.GetDesc(&mut desc);
                            let w = desc.Width;
                            let h = desc.Height;
                            if w > 0 && h > 0 {
                                let needs_new = match self.cached_tex.as_ref() {
                                    Some((_, tw, th)) => *tw != w || *th != h,
                                    None => true,
                                };
                                if needs_new {
                                    let tex_desc = D3D11_TEXTURE2D_DESC {
                                        Width: w,
                                        Height: h,
                                        MipLevels: 1,
                                        ArraySize: 1,
                                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                                        SampleDesc: DXGI_SAMPLE_DESC {
                                            Count: 1,
                                            Quality: 0,
                                        },
                                        Usage: D3D11_USAGE_DEFAULT,
                                        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                                        CPUAccessFlags: 0,
                                        MiscFlags: 0,
                                    };
                                    let mut new_tex: Option<ID3D11Texture2D> = None;
                                    if self
                                        .d3d_device
                                        .CreateTexture2D(&tex_desc, None, Some(&mut new_tex))
                                        .is_ok()
                                    {
                                        if let Some(t) = new_tex {
                                            self.cached_tex = Some((t, w, h));
                                        }
                                    }
                                }
                                if let Some((ref dst_tex, _, _)) = self.cached_tex {
                                    self.d3d_context.CopyResource(dst_tex, &src_tex);
                                    is_new = true;
                                }
                            }
                        }
                    }
                }
                let _ = frame.Close();
            }
        }
        self.cached_tex
            .as_ref()
            .map(|(t, w, h)| (t.clone(), *w, *h, is_new))
    }

    pub fn stop(self) {
        let _ = self.frame_pool.RemoveFrameArrived(self.arrived_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        if let Some(SendSync(prev)) = self.slot.pending_frame.lock().take() {
            let _ = prev.Close();
        }
        let _ = self.session.Close();
        let _ = self.frame_pool.Close();
    }
}

#[allow(dead_code)]
pub fn ensure_even(v: u32) -> u32 {
    let clamped = v.max(2);
    clamped & !1
}

#[allow(dead_code)]
pub fn compute_output_dimensions(src_w: u32, src_h: u32, resolution_mode: &str) -> (u32, u32) {
    let sw = src_w.max(2);
    let sh = src_h.max(2);

    let target_h = match resolution_mode {
        "1080p" => 1080,
        "900p" => 900,
        "720p" => 720,
        _ => return (ensure_even(sw), ensure_even(sh)),
    };

    if sh <= target_h {
        // Não fazer upscale artificial: preserva a resolução nativa par
        return (ensure_even(sw), ensure_even(sh));
    }

    let scaled_w = ((sw as f64) * (target_h as f64) / (sh as f64)).round() as u32;
    (ensure_even(scaled_w), ensure_even(target_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_hmonitor_supports_dual_monitors() {
        // Testar resolução por nome de dispositivo
        let res1 = resolve_hmonitor(r"\\.\DISPLAY1");
        assert!(res1.is_ok(), "Deve resolver DISPLAY1");

        let res2 = resolve_hmonitor(r"\\.\DISPLAY2");
        assert!(res2.is_ok(), "Deve resolver DISPLAY2");

        // Testar fallback seguro para handles inválidos
        let res_stale = resolve_hmonitor("999999999");
        assert!(res_stale.is_ok(), "Handle obsoleto deve ter fallback seguro para monitor ativo");
    }
}
