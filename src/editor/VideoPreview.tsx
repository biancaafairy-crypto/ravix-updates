import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Volume2,
  VolumeX,
  Maximize2,
  Film,
} from "lucide-react";
import type { TimelineClip, TimelineAudioTrack } from "./types";

interface VideoPreviewProps {
  playheadSecs: number;
  totalDurationSecs: number;
  isPlaying: boolean;
  videoClips: TimelineClip[];
  musicTracks: TimelineAudioTrack[];
  framingMode: "fit" | "stretch" | "fill_crop";
  selectedClipId: string | null;
  selectedTrackType: "video" | "music" | null;
  onPlayPause: () => void;
  onRestart: () => void;
  onSeek: (secs: number) => void;
  onStepFrame: (direction: -1 | 1) => void;
  onUpdateClipTransform?: (
    clipId: string,
    transform: {
      scale?: number;
      scaleX?: number;
      scaleY?: number;
      positionX?: number;
      positionY?: number;
      cropLeft?: number;
      cropRight?: number;
      cropTop?: number;
      cropBottom?: number;
    }
  ) => void;
}

function formatTimecode(secs: number): string {
  if (!secs || isNaN(secs) || secs < 0) return "00:00:00.0";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  if (h > 0) {
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}.${ms}`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms}`;
}

export function VideoPreview({
  playheadSecs,
  totalDurationSecs,
  isPlaying,
  videoClips,
  musicTracks,
  framingMode,
  selectedClipId,
  selectedTrackType,
  onPlayPause,
  onRestart,
  onSeek,
  onStepFrame,
  onUpdateClipTransform,
}: VideoPreviewProps) {
  // Dois reprodutores alternados (A/B) para eliminar qualquer piscada preta na troca de clipes
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  const [activePlayer, setActivePlayer] = useState<"A" | "B">("A");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const screenAreaRef = useRef<HTMLDivElement | null>(null);

  const [masterVolume, setMasterVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [isDraggingTransform, setIsDraggingTransform] = useState(false);

  // Encontrar clipe de vídeo sob a agulha
  const activeClipIndex = videoClips.findIndex(
    (c) =>
      playheadSecs >= c.timelineStartSecs &&
      playheadSecs < c.timelineStartSecs + c.durationSecs
  );
  const activeClip = activeClipIndex !== -1 ? videoClips[activeClipIndex] : null;

  // Próximo clipe (para pré-carregamento contínuo no reprodutor em espera)
  const nextClip =
    activeClipIndex !== -1 && activeClipIndex + 1 < videoClips.length
      ? videoClips[activeClipIndex + 1]
      : null;

  // Encontrar música de fundo ativa
  const activeMusic = musicTracks.find(
    (m) =>
      !m.isMuted &&
      playheadSecs >= m.timelineStartSecs &&
      playheadSecs < m.timelineStartSecs + m.durationSecs
  );

  // Sincronizar vídeo principal e alternar sem tela preta
  useEffect(() => {
    const primary = activePlayer === "A" ? videoRefA.current : videoRefB.current;
    const standby = activePlayer === "A" ? videoRefB.current : videoRefA.current;
    if (!primary) return;

    if (!activeClip) {
      if (!primary.paused) primary.pause();
      return;
    }

    const expectedSrc = convertFileSrc(activeClip.sourcePath);
    const targetSourceTime =
      activeClip.inPointSecs + (playheadSecs - activeClip.timelineStartSecs);

    if (primary.src === expectedSrc) {
      if (Math.abs(primary.currentTime - targetSourceTime) > 0.15) {
        primary.currentTime = targetSourceTime;
      }
    } else if (standby && standby.src === expectedSrc) {
      if (Math.abs(standby.currentTime - targetSourceTime) > 0.15) {
        standby.currentTime = targetSourceTime;
      }
      setActivePlayer((p) => (p === "A" ? "B" : "A"));
      if (isPlaying) standby.play().catch(() => {});
      primary.pause();
      return;
    } else {
      primary.src = expectedSrc;
      primary.currentTime = targetSourceTime;
    }

    // Pré-carregar o próximo clipe no player em espera
    if (standby && nextClip) {
      const nextSrc = convertFileSrc(nextClip.sourcePath);
      if (standby.src !== nextSrc) {
        standby.src = nextSrc;
        standby.currentTime = nextClip.inPointSecs;
        standby.pause();
      }
    }

    // Ajuste de volume
    const clipVol = (activeClip.isMuted ? 0 : activeClip.volume) * (isMuted ? 0 : masterVolume);
    primary.volume = Math.max(0, Math.min(1, clipVol));

    if (isPlaying && primary.paused) {
      primary.play().catch(() => {});
    } else if (!isPlaying && !primary.paused) {
      primary.pause();
    }
  }, [activeClip, isPlaying, playheadSecs, masterVolume, isMuted, activePlayer, nextClip]);

  // Sincronizar música de fundo
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!activeMusic) {
      if (!audio.paused) audio.pause();
      return;
    }

    const expectedSrc = convertFileSrc(activeMusic.sourcePath);
    const relT = playheadSecs - activeMusic.timelineStartSecs;
    const targetAudioTime = activeMusic.inPointSecs + relT;

    if (audio.src !== expectedSrc) {
      audio.src = expectedSrc;
      audio.currentTime = targetAudioTime;
    } else {
      if (Math.abs(audio.currentTime - targetAudioTime) > 0.15) {
        audio.currentTime = targetAudioTime;
      }
    }

    // Curva de volume com Fade In / Fade Out
    let fade = 1.0;
    if (activeMusic.fadeInSecs > 0 && relT < activeMusic.fadeInSecs) {
      fade = relT / activeMusic.fadeInSecs;
    } else if (
      activeMusic.fadeOutSecs > 0 &&
      relT > activeMusic.durationSecs - activeMusic.fadeOutSecs
    ) {
      fade = Math.max(0, (activeMusic.durationSecs - relT) / activeMusic.fadeOutSecs);
    }

    const musicVol =
      (activeMusic.isMuted ? 0 : activeMusic.volume) *
      fade *
      (isMuted ? 0 : masterVolume);
    audio.volume = Math.max(0, Math.min(1, musicVol));

    if (isPlaying && audio.paused) {
      audio.play().catch(() => {});
    } else if (!isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [activeMusic, isPlaying, playheadSecs, masterVolume, isMuted]);

  // Tela cheia
  function toggleFullscreen() {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // Estilo de enquadramento
  const clipFraming = activeClip?.framingMode || framingMode;
  const objectFitCls =
    clipFraming === "stretch"
      ? "object-fill"
      : clipFraming === "fill_crop"
      ? "object-cover"
      : "object-contain";

  // Parâmetros de escala, posição e recorte do clipe atual
  const clipScale = activeClip?.scale ?? 1.0;
  const clipScaleX = activeClip?.scaleX ?? clipScale;
  const clipScaleY = activeClip?.scaleY ?? clipScale;
  const clipPosX = activeClip?.positionX ?? 0;
  const clipPosY = activeClip?.positionY ?? 0;
  const cropTop = activeClip?.cropTop ?? 0;
  const cropRight = activeClip?.cropRight ?? 0;
  const cropBottom = activeClip?.cropBottom ?? 0;
  const cropLeft = activeClip?.cropLeft ?? 0;
  const isSelectedVideo =
    selectedTrackType === "video" && !!selectedClipId && activeClip?.id === selectedClipId;

  // Manipulação Visual: Arrastar para reposicionar (corpo do vídeo)
  const handleBodyMouseDown = (e: React.MouseEvent) => {
    if (!isSelectedVideo || !activeClip || !onUpdateClipTransform || !screenAreaRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    setIsDraggingTransform(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const initX = clipPosX;
    const initY = clipPosY;
    const rect = screenAreaRef.current.getBoundingClientRect();
    const w = Math.max(100, rect.width);
    const h = Math.max(100, rect.height);

    const onMove = (ev: MouseEvent) => {
      const deltaX = ((ev.clientX - startX) / w) * 100;
      const deltaY = ((ev.clientY - startY) / h) * 100;
      const nextX = Math.max(-50, Math.min(50, initX + deltaX));
      const nextY = Math.max(-50, Math.min(50, initY + deltaY));
      onUpdateClipTransform(activeClip.id, {
        positionX: Math.round(nextX * 10) / 10,
        positionY: Math.round(nextY * 10) / 10,
      });
    };

    const onUp = () => {
      setIsDraggingTransform(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Manipulação Visual Direcional: 8 Alças Reais (Escala X, Escala Y ou Ambos)
  const handleHandleMouseDown = (
    e: React.MouseEvent,
    dirX: number,
    dirY: number
  ) => {
    if (!isSelectedVideo || !activeClip || !onUpdateClipTransform || !screenAreaRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    setIsDraggingTransform(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const initScaleX = clipScaleX;
    const initScaleY = clipScaleY;

    const onMove = (ev: MouseEvent) => {
      if (dirX !== 0 && dirY === 0) {
        // Alças Laterais (Centro-Esquerda ou Centro-Direita): Altera apenas largura / ScaleX
        const deltaX = (ev.clientX - startX) * dirX;
        const nextScaleX = Math.max(0.2, Math.min(3.0, initScaleX + deltaX / 150));
        onUpdateClipTransform(activeClip.id, {
          scaleX: Math.round(nextScaleX * 100) / 100,
        });
      } else if (dirX === 0 && dirY !== 0) {
        // Alças Verticais (Topo-Centro ou Base-Centro): Altera apenas altura / ScaleY
        const deltaY = (ev.clientY - startY) * dirY;
        const nextScaleY = Math.max(0.2, Math.min(3.0, initScaleY + deltaY / 150));
        onUpdateClipTransform(activeClip.id, {
          scaleY: Math.round(nextScaleY * 100) / 100,
        });
      } else if (dirX !== 0 && dirY !== 0) {
        // 4 Cantos: Altera largura e altura simultaneamente
        const deltaX = (ev.clientX - startX) * dirX;
        const deltaY = (ev.clientY - startY) * dirY;
        const nextScaleX = Math.max(0.2, Math.min(3.0, initScaleX + deltaX / 150));
        const nextScaleY = Math.max(0.2, Math.min(3.0, initScaleY + deltaY / 150));
        onUpdateClipTransform(activeClip.id, {
          scaleX: Math.round(nextScaleX * 100) / 100,
          scaleY: Math.round(nextScaleY * 100) / 100,
          scale: Math.round(((nextScaleX + nextScaleY) / 2) * 100) / 100,
        });
      }
    };

    const onUp = () => {
      setIsDraggingTransform(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ETAPA 4: Comportamento inteligente de play/pause
  const handleSmartPlayPause = () => {
    if (playheadSecs >= totalDurationSecs - 0.1 && totalDurationSecs > 0) {
      onSeek(0);
      if (!isPlaying) {
        onPlayPause();
      }
    } else {
      onPlayPause();
    }
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#090B0E] p-3 select-none overflow-hidden"
    >
      {/* Área da Tela / Player */}
      <div
        ref={screenAreaRef}
        className="flex-1 min-h-0 min-w-0 relative flex items-center justify-center bg-black rounded-xl overflow-hidden border border-zinc-800/90 shadow-2xl"
      >
        {videoClips.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-zinc-600 gap-3 p-4">
            <Film className="h-14 w-14 stroke-1 text-zinc-700" />
            <div className="text-center">
              <p className="text-sm font-semibold text-zinc-400">Pré-visualização da Montagem</p>
              <p className="text-xs text-zinc-600 mt-1">
                Adicione clipes à timeline para começar a editar.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Player A com suporte a escala X/Y, deslocamento e corte manual */}
            <video
              ref={videoRefA}
              style={{
                transform: `translate(${clipPosX}%, ${clipPosY}%) scale(${clipScaleX}, ${clipScaleY})`,
                clipPath:
                  cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0
                    ? `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
                    : undefined,
                transformOrigin: "center center",
                transition: isDraggingTransform ? "none" : "transform 0.05s ease-out",
              }}
              className={`absolute inset-0 w-full h-full max-w-full max-h-full ${objectFitCls} bg-black transition-opacity duration-75 ${
                activePlayer === "A" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
              }`}
              playsInline
              disablePictureInPicture
            />

            {/* Player B (Standby/Preloader contínuo) */}
            <video
              ref={videoRefB}
              style={{
                transform: `translate(${clipPosX}%, ${clipPosY}%) scale(${clipScaleX}, ${clipScaleY})`,
                clipPath:
                  cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0
                    ? `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
                    : undefined,
                transformOrigin: "center center",
                transition: isDraggingTransform ? "none" : "transform 0.05s ease-out",
              }}
              className={`absolute inset-0 w-full h-full max-w-full max-h-full ${objectFitCls} bg-black transition-opacity duration-75 ${
                activePlayer === "B" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
              }`}
              playsInline
              disablePictureInPicture
            />

            {/* Bounding Box Overlay Interativo com 8 Alças Reais */}
            {isSelectedVideo && activeClip && (
              <div
                style={{
                  transform: `translate(${clipPosX}%, ${clipPosY}%) scale(${clipScaleX}, ${clipScaleY})`,
                  transformOrigin: "center center",
                  transition: isDraggingTransform ? "none" : "transform 0.05s ease-out",
                }}
                className="absolute inset-0 border-2 border-purple-400/90 pointer-events-auto z-30 shadow-[0_0_15px_rgba(168,85,247,0.3)]"
                onMouseDown={handleBodyMouseDown}
                title="Clique e arraste o corpo para reposicionar o clipe"
              >
                {/* Visualização de Recorte Interno tracejado */}
                {(cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0) && (
                  <div
                    style={{
                      top: `${cropTop}%`,
                      right: `${cropRight}%`,
                      bottom: `${cropBottom}%`,
                      left: `${cropLeft}%`,
                    }}
                    className="absolute border border-dashed border-emerald-400/80 pointer-events-none bg-emerald-500/10"
                    title="Área ativa do recorte manual (Crop)"
                  />
                )}

                {/* 4 Alças dos Cantos */}
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, -1, -1)}
                  className="absolute -top-2 -left-2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-nwse-resize hover:scale-125 transition-transform"
                  title="Redimensionar Ambos (Canto Superior Esquerdo)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, 1, -1)}
                  className="absolute -top-2 -right-2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-nesw-resize hover:scale-125 transition-transform"
                  title="Redimensionar Ambos (Canto Superior Direito)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, 1, 1)}
                  className="absolute -bottom-2 -right-2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-nwse-resize hover:scale-125 transition-transform"
                  title="Redimensionar Ambos (Canto Inferior Direito)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, -1, 1)}
                  className="absolute -bottom-2 -left-2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-nesw-resize hover:scale-125 transition-transform"
                  title="Redimensionar Ambos (Canto Inferior Esquerdo)"
                />

                {/* 4 Alças Direcionais das Bordas */}
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, 0, -1)}
                  className="absolute -top-2 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-ns-resize hover:scale-125 transition-transform"
                  title="Redimensionar Altura (Topo)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, 1, 0)}
                  className="absolute top-1/2 -right-2 -translate-y-1/2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-ew-resize hover:scale-125 transition-transform"
                  title="Redimensionar Largura (Direita)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, 0, 1)}
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-ns-resize hover:scale-125 transition-transform"
                  title="Redimensionar Altura (Base)"
                />
                <div
                  onMouseDown={(e) => handleHandleMouseDown(e, -1, 0)}
                  className="absolute top-1/2 -left-2 -translate-y-1/2 w-3.5 h-3.5 bg-purple-500 border-2 border-white rounded-sm shadow-md cursor-ew-resize hover:scale-125 transition-transform"
                  title="Redimensionar Largura (Esquerda)"
                />

                {/* Badge Discreta com Escala X e Y */}
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-sm border border-purple-500/40 text-[10px] font-mono text-purple-300 font-semibold pointer-events-none flex items-center gap-1.5">
                  <span>
                    {Math.round(clipScaleX * 100)}% × {Math.round(clipScaleY * 100)}%
                  </span>
                  <span className="text-zinc-400">
                    ({clipPosX > 0 ? `+${clipPosX}` : clipPosX}%, {clipPosY > 0 ? `+${clipPosY}` : clipPosY}%)
                  </span>
                  {(cropTop > 0 || cropRight > 0 || cropBottom > 0 || cropLeft > 0) && (
                    <span className="text-emerald-300 font-bold bg-emerald-950/60 px-1 rounded border border-emerald-500/40">
                      CROP
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Elemento de áudio para música de fundo */}
            <audio ref={audioRef} />

            {/* Indicador no fim da sequência de vídeo */}
            {!activeClip && totalDurationSecs > 0 && (
              <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-2 text-zinc-400 font-mono z-20">
                <span className="text-xs">[ Fim da sequência de vídeo ]</span>
                <button
                  type="button"
                  onClick={onRestart}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Recomeçar Montagem
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Barra de Controles e Transporte */}
      <div className="mt-2.5 px-3 py-2 rounded-xl bg-[#10141D] border border-zinc-800 flex items-center justify-between gap-4 shrink-0">
        {/* Controles de Reprodução */}
        <div className="flex items-center gap-1.5">
          {/* Botão Recomeçar (ETAPA 4) */}
          <button
            type="button"
            onClick={onRestart}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-purple-900/40 hover:text-purple-300 text-zinc-300 transition-colors cursor-pointer text-xs font-semibold flex items-center gap-1.5 border border-zinc-700/60"
            title="Recomeçar montagem do início (00:00:00)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Recomeçar</span>
          </button>

          <button
            type="button"
            onClick={() => onSeek(0)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Ir para o início (0s)"
          >
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer text-[10px] font-mono font-bold"
            title="Recuar 1 frame (-1/60s)"
          >
            -1f
          </button>
          <button
            type="button"
            onClick={handleSmartPlayPause}
            className="h-8 w-8 rounded-xl bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-md shadow-purple-900/40 transition-all cursor-pointer"
            title={isPlaying ? "Pausar (Espaço)" : "Reproduzir (Espaço)"}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={() => onStepFrame(1)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer text-[10px] font-mono font-bold"
            title="Avançar 1 frame (+1/60s)"
          >
            +1f
          </button>
          <button
            type="button"
            onClick={() => onSeek(totalDurationSecs)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Ir para o final"
          >
            <SkipForward className="h-4 w-4" />
          </button>
        </div>

        {/* Marcador de Tempo (Timecode) */}
        <div className="flex items-center gap-2 font-mono text-xs font-semibold">
          <span className="text-purple-300">{formatTimecode(playheadSecs)}</span>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-400">{formatTimecode(totalDurationSecs)}</span>
        </div>

        {/* Volume e Tela Cheia */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsMuted(!isMuted)}
              className="text-zinc-400 hover:text-white transition-colors cursor-pointer p-1"
              title={isMuted ? "Desativar Mudo" : "Silenciar Prévia"}
            >
              {isMuted || masterVolume === 0 ? (
                <VolumeX className="h-4 w-4 text-red-400" />
              ) : (
                <Volume2 className="h-4 w-4 text-zinc-300" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : masterVolume}
              onChange={(e) => {
                setMasterVolume(parseFloat(e.target.value));
                if (isMuted) setIsMuted(false);
              }}
              className="w-16 h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
              title={`Volume da Prévia: ${Math.round(masterVolume * 100)}%`}
            />
          </div>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Tela cheia"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
