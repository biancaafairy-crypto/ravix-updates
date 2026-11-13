import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const waveformCache = new Map<string, Float32Array>();

const buildCacheKey = (src: string, bucketCount: number) => `${src}::${bucketCount}`;

const getSeed = (src: string) => {
  let seed = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    seed ^= src.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
};

const generateFallbackPeaks = (bucketCount: number, seed: number) => {
  const peaks = new Float32Array(bucketCount);
  let randomState = seed || 123456789;
  for (let i = 0; i < bucketCount; i += 1) {
    randomState = (1103515245 * randomState + 12345) >>> 0;
    const noise = (randomState % 1000) / 1000;
    const shape = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.18 + noise * 2.2));
    peaks[i] = Math.max(0.1, Math.min(1, shape));
  }
  return peaks;
};

const computePeaks = (channelData: Float32Array, bucketCount: number) => {
  const peaks = new Float32Array(bucketCount);
  const step = Math.max(1, Math.floor(channelData.length / bucketCount));
  for (let i = 0; i < bucketCount; i += 1) {
    const start = i * step;
    const end = Math.min(channelData.length, start + step);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const sample = Math.abs(channelData[j]);
      if (sample > peak) {
        peak = sample;
      }
    }
    peaks[i] = peak;
  }
  return peaks;
};

interface AudioWaveformProps {
  sourcePath: string;
  widthPx: number;
  heightPx: number;
  inPointSecs?: number;
  durationSecs?: number;
  totalDurationSecs?: number;
  barColor?: string;
}

export const AudioWaveform: React.FC<AudioWaveformProps> = ({
  sourcePath,
  widthPx,
  heightPx,
  inPointSecs = 0,
  durationSecs,
  totalDurationSecs,
  barColor = "rgba(52, 211, 153, 0.7)", // Emerald 400 com 70% opacidade
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fullPeaks, setFullPeaks] = useState<Float32Array | null>(null);

  // Amostragem total para o arquivo completo (500 buckets)
  const totalBuckets = 512;

  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();

    const loadPeaks = async () => {
      if (!sourcePath) return;

      const fileSrc = convertFileSrc(sourcePath);
      const cacheKey = buildCacheKey(sourcePath, totalBuckets);
      const cached = waveformCache.get(cacheKey);

      if (cached) {
        setFullPeaks(cached);
        return;
      }

      try {
        const response = await fetch(fileSrc, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) throw new Error("AudioContext indisponível");

        const audioCtx = new AudioContextClass();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        const channelData = audioBuffer.getChannelData(0);
        const computed = computePeaks(channelData, totalBuckets);

        waveformCache.set(cacheKey, computed);
        if (!isCancelled) {
          setFullPeaks(computed);
        }
        await audioCtx.close();
      } catch {
        if (!isCancelled) {
          const fallback = generateFallbackPeaks(totalBuckets, getSeed(sourcePath));
          waveformCache.set(cacheKey, fallback);
          setFullPeaks(fallback);
        }
      }
    };

    loadPeaks();
    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [sourcePath]);

  // Recortar trecho de picos correspondente a inPointSecs e durationSecs
  const visiblePeaks = useMemo(() => {
    if (!fullPeaks) return null;
    const totalDur = totalDurationSecs || (inPointSecs + (durationSecs || 10));
    if (totalDur <= 0) return fullPeaks;

    const startFraction = Math.max(0, Math.min(1, inPointSecs / totalDur));
    const durFraction = Math.max(0.01, Math.min(1, (durationSecs || totalDur) / totalDur));
    const endFraction = Math.min(1, startFraction + durFraction);

    const startIdx = Math.floor(startFraction * fullPeaks.length);
    const endIdx = Math.max(startIdx + 1, Math.floor(endFraction * fullPeaks.length));

    return fullPeaks.slice(startIdx, endIdx);
  }, [fullPeaks, inPointSecs, durationSecs, totalDurationSecs]);

  // Renderizar barras no canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = Math.max(10, Math.floor(widthPx));
    const h = Math.max(10, Math.floor(heightPx));
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Linha central sutil
    const centerY = Math.floor(h / 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    if (!visiblePeaks || visiblePeaks.length === 0) return;

    const maxHeight = Math.max(4, h - 6);
    let peakMax = 0.001;
    for (let i = 0; i < visiblePeaks.length; i += 1) {
      if (visiblePeaks[i] > peakMax) peakMax = visiblePeaks[i];
    }

    const barWidth = 2;
    const gap = 1;
    const step = barWidth + gap;
    const numBars = Math.floor(w / step);

    ctx.fillStyle = barColor;

    for (let i = 0; i < numBars; i++) {
      const peakIndex = Math.floor((i / numBars) * visiblePeaks.length);
      const val = visiblePeaks[peakIndex] || 0;
      const normalized = Math.min(1, val / peakMax);
      const barH = Math.max(2, Math.round(normalized * maxHeight));
      const x = i * step;
      const y = Math.floor((h - barH) / 2);
      ctx.fillRect(x, y, barWidth, barH);
    }
  }, [visiblePeaks, widthPx, heightPx, barColor]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden flex items-center">
      <canvas ref={canvasRef} className="opacity-75" />
    </div>
  );
};
