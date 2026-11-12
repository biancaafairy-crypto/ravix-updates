use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use windows::core::Interface;
use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
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

pub struct LatestCaptureSlot {
    pub texture: Mutex<Option<(ID3D11Texture2D, u32, u32)>>,
    pub sequence: AtomicU64,
    pub item_closed: AtomicBool,
}

unsafe impl Send for LatestCaptureSlot {}
unsafe impl Sync for LatestCaptureSlot {}

struct SendSync<T>(T);
unsafe impl<T> Send for SendSync<T> {}
unsafe impl<T> Sync for SendSync<T> {}

pub struct WgcSession {
    item: GraphicsCaptureItem,
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrived_token: EventRegistrationToken,
    closed_token: EventRegistrationToken,
    pub initial_width: u32,
    pub initial_height: u32,
    pub slot: Arc<LatestCaptureSlot>,
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

            let raw_handle: isize = source_id
                .trim()
                .parse()
                .map_err(|_| format!("ID de fonte inválido: '{source_id}'"))?;

            let item: GraphicsCaptureItem = if source_kind == "window" {
                interop
                    .CreateForWindow(HWND(raw_handle as *mut core::ffi::c_void))
                    .map_err(|e| format!("Não foi possível capturar a janela selecionada: {e}"))?
            } else {
                interop
                    .CreateForMonitor(HMONITOR(raw_handle as *mut core::ffi::c_void))
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
                texture: Mutex::new(None),
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

            // Evento FrameArrived
            let last_size = Arc::new(Mutex::new(size));
            let slot_frame = slot.clone();
            let pool_wrap = SendSync(frame_pool.clone());
            let dev_wrap = SendSync(winrt_device.clone());
            let d3d_dev_wrap = SendSync(d3d_device.clone());
            let d3d_ctx_wrap = SendSync(d3d_context.clone());
            let staging_tex: Arc<Mutex<Option<(SendSync<ID3D11Texture2D>, u32, u32)>>> =
                Arc::new(Mutex::new(None));

            let arrived_token = frame_pool
                .FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |sender, _| {
                    let _keep = (&pool_wrap, &dev_wrap, &d3d_dev_wrap, &d3d_ctx_wrap);
                    let pool_for_cb = &pool_wrap.0;
                    let dev_for_cb = &dev_wrap.0;
                    let d3d_dev_cb = &d3d_dev_wrap.0;
                    let d3d_ctx_cb = &d3d_ctx_wrap.0;
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

                    if let Ok(surface) = frame.Surface() {
                        if let Ok(access) = surface.cast::<IDirect3DDxgiInterfaceAccess>() {
                            if let Ok(src_tex) = access.GetInterface::<ID3D11Texture2D>() {
                                let mut desc = D3D11_TEXTURE2D_DESC::default();
                                src_tex.GetDesc(&mut desc);
                                let w = desc.Width;
                                let h = desc.Height;

                                if w > 0 && h > 0 {
                                    let mut st_guard = staging_tex.lock();
                                    let needs_new = match st_guard.as_ref() {
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
                                        if d3d_dev_cb
                                            .CreateTexture2D(&tex_desc, None, Some(&mut new_tex))
                                            .is_ok()
                                        {
                                            if let Some(t) = new_tex {
                                                *st_guard = Some((SendSync(t), w, h));
                                            }
                                        }
                                    }

                                    if let Some((ref dst_tex_wrap, _, _)) = *st_guard {
                                        let dst_tex = &dst_tex_wrap.0;
                                        // Cópia ultra-rápida GPU-to-GPU; libera o frame do pool imediatamente
                                        d3d_ctx_cb.CopyResource(dst_tex, &src_tex);
                                        let mut slot_tex = slot_frame.texture.lock();
                                        *slot_tex = Some((dst_tex.clone(), w, h));
                                        slot_frame.sequence.fetch_add(1, Ordering::Release);
                                    }
                                }
                            }
                        }
                    }

                    let _ = frame.Close();
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
                initial_width: size.Width as u32,
                initial_height: size.Height as u32,
                slot,
            })
        }
    }

    pub fn stop(self) {
        let _ = self.frame_pool.RemoveFrameArrived(self.arrived_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.frame_pool.Close();
    }
}

pub fn ensure_even(v: u32) -> u32 {
    let clamped = v.max(2);
    clamped & !1
}

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
