import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
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
  onPlayPause: () => void;
  onSeek: (secs: number) => void;
  onStepFrame: (direction: -1 | 1) => void;
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
  onPlayPause,
  onSeek,
  onStepFrame,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [masterVolume, setMasterVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

  // Determinar qual clipe de vídeo está sob a agulha (playhead)
  const activeClip = videoClips.find(
    (c) =>
      playheadSecs >= c.timelineStartSecs &&
      playheadSecs < c.timelineStartSecs + c.durationSecs
  );

  // Determinar qual faixa de música está ativa na timeline
  const activeMusic = musicTracks.find(
    (m) =>
      !m.isMuted &&
      playheadSecs >= m.timelineStartSecs &&
      playheadSecs < m.timelineStartSecs + m.durationSecs
  );

  // Sincronizar vídeo
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!activeClip) {
      if (!video.paused) video.pause();
      return;
    }

    const expectedSrc = convertFileSrc(activeClip.sourcePath);
    const targetSourceTime =
      activeClip.inPointSecs + (playheadSecs - activeClip.timelineStartSecs);

    if (video.src !== expectedSrc) {
      video.src = expectedSrc;
      video.currentTime = targetSourceTime;
    } else {
      // Ajustar seek se desviar mais de 0.15s para evitar dessincronização
      if (Math.abs(video.currentTime - targetSourceTime) > 0.15) {
        video.currentTime = targetSourceTime;
      }
    }

    // Volume do clipe
    const clipVol = (activeClip.isMuted ? 0 : activeClip.volume) * (isMuted ? 0 : masterVolume);
    video.volume = Math.max(0, Math.min(1, clipVol));

    if (isPlaying && video.paused) {
      video.play().catch(() => {});
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [activeClip, isPlaying, playheadSecs, masterVolume, isMuted]);

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

    // Calcular volume com fade
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

  // Obter classe CSS de enquadramento
  const objectFitCls =
    framingMode === "stretch"
      ? "object-fill"
      : framingMode === "fill_crop"
      ? "object-cover"
      : "object-contain";

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col bg-[#090B0E] p-4 min-w-0 min-h-0 select-none"
    >
      {/* Área da Tela / Player */}
      <div className="flex-1 relative flex items-center justify-center bg-black rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl">
        {videoClips.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-zinc-600 gap-3">
            <Film className="h-16 w-16 stroke-1 text-zinc-700" />
            <div className="text-center">
              <p className="text-sm font-semibold text-zinc-400">Pré-visualização da Montagem</p>
              <p className="text-xs text-zinc-600 mt-1">
                Adicione clipes à timeline para começar a editar.
              </p>
            </div>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              className={`w-full h-full ${objectFitCls} bg-black`}
              playsInline
              disablePictureInPicture
            />
            {/* Elemento de áudio para música de fundo */}
            <audio ref={audioRef} />

            {/* Aviso sutil quando não há vídeo no ponto da agulha */}
            {!activeClip && totalDurationSecs > 0 && (
              <div className="absolute inset-0 bg-black/80 flex items-center justify-center text-xs text-zinc-500 font-mono">
                [ Fim da sequência de vídeo ]
              </div>
            )}
          </>
        )}
      </div>

      {/* Barra de Controles e Transporte */}
      <div className="mt-3 px-3 py-2 rounded-xl bg-[#10141D] border border-zinc-800 flex items-center justify-between gap-4">
        {/* Controles de Reprodução */}
        <div className="flex items-center gap-1.5">
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
            onClick={onPlayPause}
            className="h-9 w-9 rounded-xl bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-md shadow-purple-900/40 transition-all cursor-pointer"
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
