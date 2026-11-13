import React, { useEffect, useState, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const thumbCache = new Map<string, string>();

// Fila sequencial de extração para não sobrecarregar a GPU ou WebView
let isExtracting = false;
const extractionQueue: Array<() => Promise<void>> = [];

function processQueue() {
  if (isExtracting || extractionQueue.length === 0) return;
  isExtracting = true;
  const nextTask = extractionQueue.shift();
  if (nextTask) {
    nextTask().finally(() => {
      isExtracting = false;
      processQueue();
    });
  }
}

function captureVideoFrame(fileUrl: string, seekSecs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = fileUrl;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout capturando miniatura"));
    }, 4000);

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
    };

    video.onloadeddata = () => {
      video.currentTime = Math.max(0.05, seekSecs);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        const w = 96;
        const h = 54; // 16:9 proporção
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
          cleanup();
          resolve(dataUrl);
          return;
        }
        cleanup();
        reject(new Error("Contexto 2D indisponível"));
      } catch (e) {
        cleanup();
        reject(e);
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Erro ao carregar vídeo para miniatura"));
    };
  });
}

interface VideoThumbnailsProps {
  sourcePath: string;
  inPointSecs: number;
  durationSecs: number;
  widthPx: number;
}

export const VideoThumbnails: React.FC<VideoThumbnailsProps> = ({
  sourcePath,
  inPointSecs,
  durationSecs,
  widthPx,
}) => {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const thumbWidthPx = 80;

  // Quantidade de miniaturas necessárias para cobrir o comprimento visual do bloco
  const count = useMemo(() => {
    return Math.max(1, Math.min(12, Math.floor(widthPx / thumbWidthPx)));
  }, [widthPx]);

  useEffect(() => {
    let isCancelled = false;
    const fileUrl = convertFileSrc(sourcePath);
    const stepSecs = durationSecs / count;

    const loadedThumbs: string[] = [];
    const missingTasks: Array<{ index: number; cacheKey: string; time: number }> = [];

    for (let i = 0; i < count; i++) {
      const sampleTime = inPointSecs + i * stepSecs + stepSecs * 0.2;
      const key = `${sourcePath}::${sampleTime.toFixed(1)}`;
      const cached = thumbCache.get(key);
      if (cached) {
        loadedThumbs[i] = cached;
      } else {
        missingTasks.push({ index: i, cacheKey: key, time: sampleTime });
      }
    }

    setThumbnails([...loadedThumbs]);

    if (missingTasks.length === 0) return;

    // Adiciona apenas tarefas pendentes à fila com amostragem limitada
    for (const task of missingTasks) {
      extractionQueue.push(async () => {
        if (isCancelled) return;
        try {
          const dataUrl = await captureVideoFrame(fileUrl, task.time);
          thumbCache.set(task.cacheKey, dataUrl);
          if (!isCancelled) {
            setThumbnails((prev) => {
              const next = [...prev];
              next[task.index] = dataUrl;
              return next;
            });
          }
        } catch {
          // Ignora silenciosamente se o frame não puder ser capturado
        }
      });
    }

    processQueue();

    return () => {
      isCancelled = true;
    };
  }, [sourcePath, inPointSecs, durationSecs, count]);

  return (
    <div className="absolute inset-0 flex overflow-hidden opacity-30 pointer-events-none select-none">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{ width: `${thumbWidthPx}px` }}
          className="h-full shrink-0 border-r border-black/30 overflow-hidden bg-black/40"
        >
          {thumbnails[i] && (
            <img
              src={thumbnails[i]}
              alt=""
              className="w-full h-full object-cover select-none pointer-events-none"
            />
          )}
        </div>
      ))}
    </div>
  );
};
