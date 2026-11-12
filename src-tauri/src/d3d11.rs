use windows::core::Interface;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::{HANDLE, RECT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
    ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_RESOURCE_MISC_SHARED, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGIResource};
use windows::Win32::Media::MediaFoundation::{IMFDXGIDeviceManager, MFCreateDXGIDeviceManager};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

pub struct D3D11Context {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub winrt_device: IDirect3DDevice,
    pub mf_dxgi_manager: IMFDXGIDeviceManager,
    _reset_token: u32,
}

impl D3D11Context {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;

            let hr = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );

            if hr.is_err() {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&feature_levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
                .map_err(|e| format!("Falha ao inicializar Direct3D 11: {e}"))?;
            }

            let device = device.ok_or("ID3D11Device nulo")?;
            let context = context.ok_or("ID3D11DeviceContext nulo")?;

            if let Ok(multithread) = device.cast::<ID3D11Multithread>() {
                let _ = multithread.SetMultithreadProtected(true);
            }

            let dxgi_device: IDXGIDevice = device
                .cast()
                .map_err(|e| format!("Falha ao obter IDXGIDevice: {e}"))?;

            let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
                .map_err(|e| format!("Falha ao criar WinRT Direct3DDevice: {e}"))?;
            let winrt_device: IDirect3DDevice = inspectable
                .cast()
                .map_err(|e| format!("Falha ao converter IDirect3DDevice: {e}"))?;

            let mut reset_token: u32 = 0;
            let mut manager: Option<IMFDXGIDeviceManager> = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
                .map_err(|e| format!("Falha ao criar MF DXGIDeviceManager: {e}"))?;
            let mf_dxgi_manager = manager.ok_or("IMFDXGIDeviceManager nulo")?;

            mf_dxgi_manager
                .ResetDevice(&device, reset_token)
                .map_err(|e| format!("Falha ao vincular D3D11 ao Media Foundation: {e}"))?;

            Ok(Self {
                device,
                context,
                winrt_device,
                mf_dxgi_manager,
                _reset_token: reset_token,
            })
        }
    }
}

pub struct GpuBgraToNv12 {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    staging_bgra: ID3D11Texture2D,
    input_view: ID3D11VideoProcessorInputView,
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
}

impl GpuBgraToNv12 {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    ) -> Result<Self, String> {
        unsafe {
            let video_device: ID3D11VideoDevice = device
                .cast()
                .map_err(|e| format!("GPU sem suporte a ID3D11VideoDevice: {e}"))?;
            let video_context: ID3D11VideoContext = context
                .cast()
                .map_err(|e| format!("Falha ao obter ID3D11VideoContext: {e}"))?;

            let mut obj = Self::build_pipeline(
                device,
                context,
                video_device,
                video_context,
                src_w.max(2),
                src_h.max(2),
                dst_w.max(2),
                dst_h.max(2),
            )?;
            obj.configure_rects();
            Ok(obj)
        }
    }

    unsafe fn build_pipeline(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        video_device: ID3D11VideoDevice,
        video_context: ID3D11VideoContext,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    ) -> Result<Self, String> {
        let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: Default::default(),
            InputWidth: src_w,
            InputHeight: src_h,
            OutputFrameRate: Default::default(),
            OutputWidth: dst_w,
            OutputHeight: dst_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };

        let enumerator = video_device
            .CreateVideoProcessorEnumerator(&content_desc)
            .map_err(|e| format!("Falha CreateVideoProcessorEnumerator: {e}"))?;
        let processor = video_device
            .CreateVideoProcessor(&enumerator, 0)
            .map_err(|e| format!("Falha CreateVideoProcessor: {e}"))?;

        let bgra_desc = D3D11_TEXTURE2D_DESC {
            Width: src_w,
            Height: src_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        let mut staging_bgra: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&bgra_desc, None, Some(&mut staging_bgra))
            .map_err(|e| format!("Falha CreateTexture2D BGRA: {e}"))?;
        let staging_bgra = staging_bgra.ok_or("staging_bgra nula")?;

        let in_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                Texture2D: windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPIV {
                    MipSlice: 0,
                    ArraySlice: 0,
                },
            },
        };

        let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
        video_device
            .CreateVideoProcessorInputView(&staging_bgra, &enumerator, &in_view_desc, Some(&mut input_view))
            .map_err(|e| format!("Falha CreateVideoProcessorInputView: {e}"))?;
        let input_view = input_view.ok_or("input_view nulo")?;

        Ok(Self {
            device,
            context,
            video_device,
            video_context,
            enumerator,
            processor,
            staging_bgra,
            input_view,
            src_w,
            src_h,
            dst_w,
            dst_h,
        })
    }

    unsafe fn configure_rects(&mut self) {
        let src_rect = RECT {
            left: 0,
            top: 0,
            right: self.src_w as i32,
            bottom: self.src_h as i32,
        };
        let dst_rect = RECT {
            left: 0,
            top: 0,
            right: self.dst_w as i32,
            bottom: self.dst_h as i32,
        };
        self.video_context
            .VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src_rect));
        self.video_context
            .VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dst_rect));
        self.video_context
            .VideoProcessorSetOutputTargetRect(&self.processor, true, Some(&dst_rect));
    }

    pub fn create_nv12_texture(&self) -> Result<(ID3D11Texture2D, ID3D11VideoProcessorOutputView), String> {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: self.dst_w,
                Height: self.dst_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| format!("Falha CreateTexture2D NV12: {e}"))?;
            let tex = tex.ok_or("NV12 texture nula")?;

            let out_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: windows::Win32::Graphics::Direct3D11::D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut out_view: Option<ID3D11VideoProcessorOutputView> = None;
            self.video_device
                .CreateVideoProcessorOutputView(&tex, &self.enumerator, &out_desc, Some(&mut out_view))
                .map_err(|e| format!("Falha CreateVideoProcessorOutputView: {e}"))?;
            let out_view = out_view.ok_or("out_view nulo")?;
            Ok((tex, out_view))
        }
    }

    /// Converte na GPU a textura BGRA vinda do WGC para uma textura NV12 de saída.
    pub fn convert_bgra_to_nv12(
        &mut self,
        wgc_tex: &ID3D11Texture2D,
        output_view: &ID3D11VideoProcessorOutputView,
    ) -> Result<(), String> {
        unsafe {
            let mut src_desc = D3D11_TEXTURE2D_DESC::default();
            wgc_tex.GetDesc(&mut src_desc);

            if src_desc.Width != self.src_w || src_desc.Height != self.src_h {
                // Copia somente a região que cabe (ou recria staging se aumentou)
                let new_w = src_desc.Width.max(2);
                let new_h = src_desc.Height.max(2);
                if new_w != self.src_w || new_h != self.src_h {
                    let rebuilt = Self::build_pipeline(
                        self.device.clone(),
                        self.context.clone(),
                        self.video_device.clone(),
                        self.video_context.clone(),
                        new_w,
                        new_h,
                        self.dst_w,
                        self.dst_h,
                    )?;
                    self.staging_bgra = rebuilt.staging_bgra;
                    self.input_view = rebuilt.input_view;
                    self.enumerator = rebuilt.enumerator;
                    self.processor = rebuilt.processor;
                    self.src_w = new_w;
                    self.src_h = new_h;
                    self.configure_rects();
                }
            }

            let box_region = D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: src_desc.Width.min(self.src_w),
                bottom: src_desc.Height.min(self.src_h),
                back: 1,
            };
            self.context.CopySubresourceRegion(
                &self.staging_bgra,
                0,
                0,
                0,
                0,
                wgc_tex,
                0,
                Some(&box_region),
            );

            let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(self.input_view.clone())),
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };

            let res = self
                .video_context
                .VideoProcessorBlt(&self.processor, output_view, 0, std::slice::from_ref(&stream));

            // Liberar ManuallyDrop da interface input_view para não vazar refcount!
            let _ = std::mem::ManuallyDrop::into_inner(stream.pInputSurface);
            self.context.Flush();

            res.map_err(|e| format!("Falha VideoProcessorBlt GPU: {e}"))
        }
    }
}

/// Ponte Zero-Copy na VRAM entre o D3D11Device de captura (WGC) e o D3D11Device do Encoder (MF/AMF/NVENC).
pub struct SharedGpuBridge {
    cap_device: ID3D11Device,
    cap_context: ID3D11DeviceContext,
    enc_device: ID3D11Device,
    cap_shared_tex: ID3D11Texture2D,
    enc_shared_tex: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl SharedGpuBridge {
    pub fn new(
        cap_device: ID3D11Device,
        cap_context: ID3D11DeviceContext,
        enc_device: ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let (cap_shared_tex, enc_shared_tex) =
            Self::alloc_pair(&cap_device, &enc_device, width.max(2), height.max(2))?;
        Ok(Self {
            cap_device,
            cap_context,
            enc_device,
            cap_shared_tex,
            enc_shared_tex,
            width: width.max(2),
            height: height.max(2),
        })
    }

    fn alloc_pair(
        cap_device: &ID3D11Device,
        enc_device: &ID3D11Device,
        width: u32,
        height: u32,
    ) -> Result<(ID3D11Texture2D, ID3D11Texture2D), String> {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: D3D11_RESOURCE_MISC_SHARED.0 as u32,
            };
            let mut cap_tex: Option<ID3D11Texture2D> = None;
            cap_device
                .CreateTexture2D(&desc, None, Some(&mut cap_tex))
                .map_err(|e| format!("Falha CreateTexture2D Shared: {e}"))?;
            let cap_tex = cap_tex.ok_or("cap_shared_tex nula")?;

            let dxgi_res: IDXGIResource = cap_tex
                .cast()
                .map_err(|e| format!("Falha cast IDXGIResource: {e}"))?;
            let shared_handle: HANDLE = dxgi_res
                .GetSharedHandle()
                .map_err(|e| format!("Falha GetSharedHandle: {e}"))?;

            let mut enc_tex: Option<ID3D11Texture2D> = None;
            enc_device
                .OpenSharedResource(shared_handle, &mut enc_tex)
                .map_err(|e| format!("Falha OpenSharedResource: {e}"))?;
            let enc_tex = enc_tex.ok_or("enc_shared_tex nula")?;

            Ok((cap_tex, enc_tex))
        }
    }

    pub fn transfer(&mut self, wgc_bgra: &ID3D11Texture2D) -> Result<&ID3D11Texture2D, String> {
        unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            wgc_bgra.GetDesc(&mut desc);
            let w = desc.Width.max(2);
            let h = desc.Height.max(2);

            if w != self.width || h != self.height {
                let (c, e) = Self::alloc_pair(&self.cap_device, &self.enc_device, w, h)?;
                self.cap_shared_tex = c;
                self.enc_shared_tex = e;
                self.width = w;
                self.height = h;
            }

            self.cap_context.CopyResource(&self.cap_shared_tex, wgc_bgra);
            self.cap_context.Flush();
            Ok(&self.enc_shared_tex)
        }
    }
}
