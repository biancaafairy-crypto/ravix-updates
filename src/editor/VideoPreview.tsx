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
  // Dois reprodutores alternados (A/B) para eliminar qualquer piscada preta na troca de clipes
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  const [activePlayer, setActivePlayer] = useState<"A" | "B">("A");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [masterVolume, setMasterVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

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

    // Se o player ativo já está com o mesmo arquivo fonte, apenas ajusta seek suave
    if (primary.src === expectedSrc) {
      if (Math.abs(primary.currentTime - targetSourceTime) > 0.15) {
        primary.currentTime = targetSourceTime;
      }
    } else if (standby && standby.src === expectedSrc) {
      // Se o player em espera já continha o arquivo pré-carregado, troca para ele imediatamente
      if (Math.abs(standby.currentTime - targetSourceTime) > 0.15) {
        standby.currentTime = targetSourceTime;
      }
      setActivePlayer((p) => (p === "A" ? "B" : "A"));
      if (isPlaying) standby.play().catch(() => {});
      primary.pause();
      return;
    } else {
      // Carrega no player ativo mantendo o último frame até carregar
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

  // Estilo de enquadramento (sempre contido no viewport estável)
  const objectFitCls =
    framingMode === "stretch"
      ? "object-fill"
      : framingMode === "fill_crop"
      ? "object-cover"
      : "object-contain";

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#090B0E] p-3 select-none overflow-hidden"
    >
      {/* 
        Área da Tela / Player: 
        Rigidamente limitada pelo flex-1 e min-h-0 para NUNCA crescer acima do espaço disponível 
        ou empurrar a timeline para fora da janela.
      */}
      <div className="flex-1 min-h-0 min-w-0 relative flex items-center justify-center bg-black rounded-xl overflow-hidden border border-zinc-800/90 shadow-2xl">
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
            {/* Player A */}
            <video
              ref={videoRefA}
              className={`absolute inset-0 w-full h-full max-w-full max-h-full ${objectFitCls} bg-black transition-opacity duration-75 ${
                activePlayer === "A" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
              }`}
              playsInline
              disablePictureInPicture
            />

            {/* Player B (Standby/Preloader contínuo) */}
            <video
              ref={videoRefB}
              className={`absolute inset-0 w-full h-full max-w-full max-h-full ${objectFitCls} bg-black transition-opacity duration-75 ${
                activePlayer === "B" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
              }`}
              playsInline
              disablePictureInPicture
            />

            {/* Elemento de áudio para música de fundo */}
            <audio ref={audioRef} />

            {/* Indicador no fim da sequência de vídeo */}
            {!activeClip && totalDurationSecs > 0 && (
              <div className="absolute inset-0 bg-black/85 flex items-center justify-center text-xs text-zinc-500 font-mono z-20">
                [ Fim da sequência de vídeo ]
              </div>
            )}
          </>
        )}
      </div>

      {/* Barra de Controles e Transporte */}
      <div className="mt-2.5 px-3 py-2 rounded-xl bg-[#10141D] border border-zinc-800 flex items-center justify-between gap-4 shrink-0">
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
