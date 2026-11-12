use windows::Win32::Foundation::RECT;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramingMode {
    Stretch,
    Fit,
    FillCrop,
}

#[allow(dead_code)]
impl FramingMode {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "fit" | "manter_proporcao" | "manter" => Self::Fit,
            "fill_crop" | "fill" | "crop" | "preencher_cortar" => Self::FillCrop,
            _ => Self::Stretch,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Stretch => "stretch",
            Self::Fit => "fit",
            Self::FillCrop => "fill_crop",
        }
    }
}

pub fn ensure_even(v: u32) -> u32 {
    let clamped = v.max(2);
    clamped & !1
}

/// Calcula a resolução alvo em pixels (largura, altura) com base no modo selecionado.
pub fn compute_target_dimensions(
    src_w: u32,
    src_h: u32,
    resolution_mode: &str,
    custom_w: Option<u32>,
    custom_h: Option<u32>,
) -> (u32, u32) {
    let sw = ensure_even(src_w);
    let sh = ensure_even(src_h);

    match resolution_mode.trim().to_lowercase().as_str() {
        "1080p" | "1920x1080" => (1920, 1080),
        "1440p" | "2560x1440" => (2560, 1440),
        "custom" => {
            let cw = ensure_even(custom_w.unwrap_or(1920));
            let ch = ensure_even(custom_h.unwrap_or(1080));
            (cw, ch)
        }
        _ => (sw, sh), // "native" | "original"
    }
}

/// Verifica se a proporção de aspecto da fonte e do destino já são equivalentes (16:9 vs 16:9),
/// evitando dupla distorção caso a captura já chegue esticada pelo driver/Windows.
#[allow(dead_code)]
pub fn is_aspect_ratio_matched(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> bool {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return false;
    }
    let src_ar = (src_w as f64) / (src_h as f64);
    let dst_ar = (dst_w as f64) / (dst_h as f64);
    (src_ar - dst_ar).abs() < 0.015
}

/// Calcula os retângulos de origem (source_rect) e destino (dest_rect) para o VideoProcessor do D3D11.
///
/// Modos de enquadramento:
/// - `stretch`: Estica imagem em X e Y para cobrir todo o destino (0 barras pretas adicionadas).
///   Comportamento idêntico a OBS "Estender à tela (Ctrl+S)".
/// - `fit`: Preserva a proporção original, adicionando barras se necessário (letterbox / pillarbox).
/// - `fill_crop`: Preenche todo o destino sem distorcer, cortando apenas as bordas excedentes.
pub fn compute_transform_rects(
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    framing_mode: &str,
) -> (RECT, RECT) {
    let sw = ensure_even(src_w);
    let sh = ensure_even(src_h);
    let dw = ensure_even(dst_w);
    let dh = ensure_even(dst_h);

    let mode = FramingMode::parse(framing_mode);

    // Se já tiver a mesma resolução ou o mesmo aspect ratio e for modo stretch,
    // o mapeamento 1:1 é perfeito e natural (sem dupla distorção).
    if sw == dw && sh == dh {
        return (
            RECT { left: 0, top: 0, right: sw as i32, bottom: sh as i32 },
            RECT { left: 0, top: 0, right: dw as i32, bottom: dh as i32 },
        );
    }

    match mode {
        FramingMode::Stretch => {
            // Estica todo o quadro de entrada diretamente no quadro de saída.
            // Sem barras pretas adicionadas, estica horizontalmente e/ou verticalmente.
            (
                RECT { left: 0, top: 0, right: sw as i32, bottom: sh as i32 },
                RECT { left: 0, top: 0, right: dw as i32, bottom: dh as i32 },
            )
        }
        FramingMode::Fit => {
            // Preserva aspecto. Adiciona pillarbox ou letterbox centralizado.
            let src_ar = (sw as f64) / (sh as f64);
            let dst_ar = (dw as f64) / (dh as f64);

            let (fit_w, fit_h) = if src_ar > dst_ar {
                // Entrada mais larga: letterbox (barras no topo e embaixo)
                let w = dw;
                let h = ((dw as f64) / src_ar).round() as u32;
                (ensure_even(w), ensure_even(h))
            } else {
                // Entrada mais estreita (ex: 1100x1080 em 1920x1080): pillarbox (barras laterais)
                let h = dh;
                let w = ((dh as f64) * src_ar).round() as u32;
                (ensure_even(w), ensure_even(h))
            };

            let offset_x = ((dw.saturating_sub(fit_w)) / 2) as i32;
            let offset_y = ((dh.saturating_sub(fit_h)) / 2) as i32;

            (
                RECT { left: 0, top: 0, right: sw as i32, bottom: sh as i32 },
                RECT {
                    left: offset_x,
                    top: offset_y,
                    right: offset_x + fit_w as i32,
                    bottom: offset_y + fit_h as i32,
                },
            )
        }
        FramingMode::FillCrop => {
            // Preenche todo o quadro de saída, cortando o excesso da entrada centralizada.
            let src_ar = (sw as f64) / (sh as f64);
            let dst_ar = (dw as f64) / (dh as f64);

            let (crop_w, crop_h) = if src_ar > dst_ar {
                // Entrada mais larga que destino: corta laterais
                let h = sh;
                let w = ((sh as f64) * dst_ar).round() as u32;
                (ensure_even(w), ensure_even(h))
            } else {
                // Entrada mais estreita/alta: corta topo e base
                let w = sw;
                let h = ((sw as f64) / dst_ar).round() as u32;
                (ensure_even(w), ensure_even(h))
            };

            let offset_x = ((sw.saturating_sub(crop_w)) / 2) as i32;
            let offset_y = ((sh.saturating_sub(crop_h)) / 2) as i32;

            (
                RECT {
                    left: offset_x,
                    top: offset_y,
                    right: offset_x + crop_w as i32,
                    bottom: offset_y + crop_h as i32,
                },
                RECT { left: 0, top: 0, right: dw as i32, bottom: dh as i32 },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stretched_resolution_1100x1080_to_1920x1080() {
        let (out_w, out_h) = compute_target_dimensions(1100, 1080, "1080p", None, None);
        assert_eq!(out_w, 1920);
        assert_eq!(out_h, 1080);

        let (src_rect, dst_rect) = compute_transform_rects(1100, 1080, out_w, out_h, "stretch");
        assert_eq!(src_rect.left, 0);
        assert_eq!(src_rect.top, 0);
        assert_eq!(src_rect.right, 1100);
        assert_eq!(src_rect.bottom, 1080);

        assert_eq!(dst_rect.left, 0);
        assert_eq!(dst_rect.top, 0);
        assert_eq!(dst_rect.right, 1920);
        assert_eq!(dst_rect.bottom, 1080);
    }

    #[test]
    fn test_fit_resolution_1100x1080_to_1920x1080() {
        let (src_rect, dst_rect) = compute_transform_rects(1100, 1080, 1920, 1080, "fit");
        assert_eq!(src_rect.right, 1100);
        assert_eq!(src_rect.bottom, 1080);
        // Em fit, 1100x1080 em tela 1920x1080 cria pillarbox centralizado
        assert!(dst_rect.left > 0);
        assert!(dst_rect.right < 1920);
        assert_eq!(dst_rect.top, 0);
        assert_eq!(dst_rect.bottom, 1080);
    }

    #[test]
    fn test_fill_crop_1100x1080_to_1920x1080() {
        let (src_rect, dst_rect) = compute_transform_rects(1100, 1080, 1920, 1080, "fill_crop");
        // Em fill_crop, corta topo e fundo da entrada para caber em 16:9
        assert_eq!(src_rect.left, 0);
        assert_eq!(src_rect.right, 1100);
        assert!(src_rect.top > 0);
        assert!(src_rect.bottom < 1080);

        assert_eq!(dst_rect.left, 0);
        assert_eq!(dst_rect.top, 0);
        assert_eq!(dst_rect.right, 1920);
        assert_eq!(dst_rect.bottom, 1080);
    }

    #[test]
    fn test_already_stretched_source_detection() {
        assert!(is_aspect_ratio_matched(1920, 1080, 1920, 1080));
        assert!(is_aspect_ratio_matched(2560, 1440, 1920, 1080));
        assert!(!is_aspect_ratio_matched(1100, 1080, 1920, 1080));
    }
}
