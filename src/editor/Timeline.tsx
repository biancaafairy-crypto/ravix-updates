import React, { useRef, useState, useEffect } from "react";
import { Film, Music } from "lucide-react";
import type { TimelineClip, TimelineAudioTrack } from "./types";
import { AudioWaveform } from "./AudioWaveform";
import { VideoThumbnails } from "./VideoThumbnails";

interface TimelineProps {
  playheadSecs: number;
  totalDurationSecs: number;
  zoom: number; // pixels por segundo
  snapping: boolean;
  isPlaying?: boolean;
  videoClips: TimelineClip[];
  musicTracks: TimelineAudioTrack[];
  selectedClipId: string | null;
  selectedTrackType: "video" | "music" | null;
  onSelectClip: (id: string | null, type: "video" | "music" | null) => void;
  onSeek: (secs: number) => void;
  onUpdateClip: (clip: TimelineClip) => void;
  onUpdateMusic: (track: TimelineAudioTrack) => void;
  onReorderClips: (fromIndex: number, toIndex: number) => void;
}

function formatRulerTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Timeline({
  playheadSecs,
  totalDurationSecs,
  zoom,
  snapping,
  isPlaying,
  videoClips,
  musicTracks,
  selectedClipId,
  selectedTrackType,
  onSelectClip,
  onSeek,
  onUpdateClip,
  onUpdateMusic,
  onReorderClips,
}: TimelineProps) {
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [draggedClipIndex, setDraggedClipIndex] = useState<number | null>(null);

  // ETAPA 3: Auto-following durante a reprodução
  useEffect(() => {
    if (!isPlaying || isDraggingPlayhead || !timelineScrollRef.current) return;
    const scrollContainer = timelineScrollRef.current;
    const playheadPx = playheadSecs * zoom;
    const scrollLeft = scrollContainer.scrollLeft;
    const visibleWidth = scrollContainer.clientWidth;

    if (playheadPx > scrollLeft + visibleWidth - 80) {
      scrollContainer.scrollLeft = playheadPx - 80;
    } else if (playheadPx < scrollLeft) {
      scrollContainer.scrollLeft = Math.max(0, playheadPx - 40);
    }
  }, [isPlaying, playheadSecs, zoom, isDraggingPlayhead]);

  // Determinar extensão total da timeline
  const maxContentDuration = Math.max(
    totalDurationSecs,
    ...musicTracks.map((m) => m.timelineStartSecs + m.durationSecs),
    10
  );
  const timelineWidth = Math.max(1200, (maxContentDuration + 15) * zoom);

  // Pontos candidatos para encaixe magnético (Snapping)
  const snapPoints = React.useMemo(() => {
    if (!snapping) return [];
    const points = [0];
    for (const c of videoClips) {
      points.push(c.timelineStartSecs);
      points.push(c.timelineStartSecs + c.durationSecs);
    }
    for (const m of musicTracks) {
      points.push(m.timelineStartSecs);
      points.push(m.timelineStartSecs + m.durationSecs);
    }
    return Array.from(new Set(points)).sort((a, b) => a - b);
  }, [snapping, videoClips, musicTracks]);

  const applySnap = (targetSecs: number, tolerance = 0.25): number => {
    if (!snapping) return targetSecs;
    for (const p of snapPoints) {
      if (Math.abs(targetSecs - p) < tolerance) {
        return p;
      }
    }
    return targetSecs;
  };

  // Clique e arrasto na régua
  const handleRulerMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineScrollRef.current) return;
    const rect = timelineScrollRef.current.getBoundingClientRect();
    const scrollLeft = timelineScrollRef.current.scrollLeft;
    const clickX = e.clientX - rect.left + scrollLeft;
    let targetSecs = Math.max(0, clickX / zoom);
    targetSecs = applySnap(targetSecs);

    onSeek(targetSecs);
    setIsDraggingPlayhead(true);
  };

  useEffect(() => {
    if (!isDraggingPlayhead) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineScrollRef.current) return;
      const rect = timelineScrollRef.current.getBoundingClientRect();

      // ETAPA 3: Auto-scroll ao arrastar playhead para próximo da borda (<80px)
      const relX = e.clientX - rect.left;
      if (relX < 80) {
        const speed = Math.max(2, Math.round(((80 - Math.max(0, relX)) / 80) * 18));
        timelineScrollRef.current.scrollLeft -= speed;
      } else if (relX > rect.width - 80) {
        const speed = Math.max(2, Math.round(((Math.min(rect.width, relX) - (rect.width - 80)) / 80) * 18));
        timelineScrollRef.current.scrollLeft += speed;
      }

      const scrollLeft = timelineScrollRef.current.scrollLeft;
      const clickX = e.clientX - rect.left + scrollLeft;
      let targetSecs = Math.max(0, clickX / zoom);
      targetSecs = applySnap(targetSecs);
      onSeek(targetSecs);
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead, zoom, onSeek, applySnap]);

  // Marcadores da régua
  const tickInterval = zoom >= 60 ? 1 : zoom >= 30 ? 5 : 10;
  const numTicks = Math.ceil(timelineWidth / (tickInterval * zoom));
  const rulerTicks = Array.from({ length: numTicks }, (_, i) => i * tickInterval);

  // 1. Arrastar e cortar bordas do Clipe de Vídeo (Trim In / Trim Out)
  const handleVideoTrimStart = (
    e: React.MouseEvent,
    clip: TimelineClip,
    edge: "left" | "right"
  ) => {
    e.stopPropagation();
    const startX = e.clientX;
    const initialIn = clip.inPointSecs;
    const initialOut = clip.outPointSecs;

    const onMove = (ev: MouseEvent) => {
      const deltaSecs = (ev.clientX - startX) / zoom;
      if (edge === "left") {
        const nextIn = Math.max(0, Math.min(initialOut - 0.2, initialIn + deltaSecs));
        onUpdateClip({
          ...clip,
          inPointSecs: nextIn,
          durationSecs: clip.outPointSecs - nextIn,
        });
      } else {
        const nextOut = Math.max(clip.inPointSecs + 0.2, initialOut + deltaSecs);
        onUpdateClip({
          ...clip,
          outPointSecs: nextOut,
          durationSecs: nextOut - clip.inPointSecs,
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 2. Arrastar e cortar bordas de Trecho Musical (Trim In / Trim Out)
  const handleMusicTrimStart = (
    e: React.MouseEvent,
    track: TimelineAudioTrack,
    edge: "left" | "right"
  ) => {
    e.stopPropagation();
    const startX = e.clientX;
    const initialIn = track.inPointSecs;
    const initialStart = track.timelineStartSecs;
    const initialDuration = track.durationSecs;

    const onMove = (ev: MouseEvent) => {
      const deltaSecs = (ev.clientX - startX) / zoom;
      if (edge === "left") {
        const nextIn = Math.max(0, Math.min(initialIn + initialDuration - 0.2, initialIn + deltaSecs));
        const actualDelta = nextIn - initialIn;
        onUpdateMusic({
          ...track,
          timelineStartSecs: Math.max(0, initialStart + actualDelta),
          inPointSecs: nextIn,
          durationSecs: Math.max(0.2, initialDuration - actualDelta),
        });
      } else {
        const nextDur = Math.max(0.2, initialDuration + deltaSecs);
        onUpdateMusic({
          ...track,
          durationSecs: nextDur,
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 3. Mover faixa de música pela timeline
  const handleMusicDrag = (e: React.MouseEvent, track: TimelineAudioTrack) => {
    e.stopPropagation();
    onSelectClip(track.id, "music");
    const startX = e.clientX;
    const initialStart = track.timelineStartSecs;

    const onMove = (ev: MouseEvent) => {
      const deltaSecs = (ev.clientX - startX) / zoom;
      let nextStart = Math.max(0, initialStart + deltaSecs);
      nextStart = applySnap(nextStart, 0.2);
      onUpdateMusic({
        ...track,
        timelineStartSecs: nextStart,
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex-1 flex flex-col bg-[#07090D] overflow-hidden select-none">
      {/* Container de Faixas com Scroll Horizontal */}
      <div
        ref={timelineScrollRef}
        className="flex-1 overflow-x-auto overflow-y-hidden relative flex flex-col"
      >
        <div style={{ width: `${timelineWidth}px` }} className="relative flex-1 flex flex-col">
          {/* 1. Régua de Tempo */}
          <div
            onMouseDown={handleRulerMouseDown}
            className="h-7 bg-[#0B0E14] border-b border-zinc-800 relative cursor-pointer flex items-end text-[10px] font-mono text-zinc-500 shrink-0"
          >
            {rulerTicks.map((sec) => (
              <div
                key={sec}
                style={{ left: `${sec * zoom}px` }}
                className="absolute bottom-0 flex flex-col items-start pointer-events-none"
              >
                <span className="text-[9px] text-zinc-400 pl-1 mb-0.5">
                  {formatRulerTime(sec)}
                </span>
                <div className="h-2 w-px bg-zinc-700" />
              </div>
            ))}
          </div>

          {/* 2. Área das Faixas */}
          <div
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                onSelectClip(null, null);
              }
            }}
            className="flex-1 flex flex-col py-2 space-y-2 cursor-default"
          >
            {/* Faixa 1: Vídeo & Áudio do Jogo */}
            <div
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  onSelectClip(null, null);
                }
              }}
              className="h-16 bg-[#0E121A] border-y border-zinc-800/80 relative flex items-center"
            >
              {/* Rótulo da Faixa */}
              <div className="absolute left-2 z-20 pointer-events-none flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm border border-zinc-700/60 text-[10px] font-semibold text-purple-300">
                <Film className="h-3 w-3 text-purple-400" />
                VÍDEO
              </div>

              {/* Blocos dos Clipes de Vídeo */}
              {videoClips.map((clip, index) => {
                const isSelected = selectedClipId === clip.id && selectedTrackType === "video";
                const leftPx = clip.timelineStartSecs * zoom;
                const widthPx = Math.max(24, clip.durationSecs * zoom);

                return (
                  <div
                    key={clip.id}
                    draggable
                    onDragStart={(e) => {
                      setDraggedClipIndex(index);
                      e.dataTransfer.setData("text/plain", String(index));
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedClipIndex !== null && draggedClipIndex !== index) {
                        onReorderClips(draggedClipIndex, index);
                        setDraggedClipIndex(null);
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectClip(clip.id, "video");
                    }}
                    style={{
                      left: `${leftPx}px`,
                      width: `${widthPx}px`,
                    }}
                    className={`absolute h-14 rounded-xl border flex items-center justify-between overflow-hidden cursor-pointer transition-all ${
                      isSelected
                        ? "bg-gradient-to-r from-purple-900/80 to-purple-800/80 ring-2 ring-purple-400 border-purple-400 shadow-xl shadow-purple-950/60 z-20"
                        : "bg-gradient-to-r from-zinc-800/90 to-[#1C1F2E] border-zinc-700/80 hover:border-purple-500/50 z-10"
                    }`}
                  >
                    {/* Miniaturas Reais do Vídeo ao fundo */}
                    <VideoThumbnails
                      sourcePath={clip.sourcePath}
                      inPointSecs={clip.inPointSecs}
                      durationSecs={clip.durationSecs}
                      widthPx={widthPx}
                    />

                    {/* Alça de corte esquerdo (Trim In) */}
                    <div
                      onMouseDown={(e) => handleVideoTrimStart(e, clip, "left")}
                      className="w-2.5 h-full bg-purple-500/30 hover:bg-purple-500/70 cursor-ew-resize flex items-center justify-center shrink-0 z-10"
                      title="Arrastar para cortar início (Trim In)"
                    >
                      <div className="w-0.5 h-4 bg-purple-300 rounded" />
                    </div>

                    {/* Conteúdo Central do Bloco */}
                    <div className="flex-1 px-2 min-w-0 overflow-hidden z-10 drop-shadow-md">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-white truncate">
                        <span className="truncate">{clip.name}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-zinc-300 font-mono mt-0.5">
                        <span>{clip.durationSecs.toFixed(1)}s</span>
                        {clip.volume !== 1 && (
                          <span className="text-purple-300">Vol: {Math.round(clip.volume * 100)}%</span>
                        )}
                        {clip.isMuted && <span className="text-red-400 font-bold">MUDO</span>}
                      </div>
                    </div>

                    {/* Alça de corte direito (Trim Out) */}
                    <div
                      onMouseDown={(e) => handleVideoTrimStart(e, clip, "right")}
                      className="w-2.5 h-full bg-purple-500/30 hover:bg-purple-500/70 cursor-ew-resize flex items-center justify-center shrink-0 z-10"
                      title="Arrastar para cortar fim (Trim Out)"
                    >
                      <div className="w-0.5 h-4 bg-purple-300 rounded" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Faixa 2: Músicas de Fundo (Suporte Multitrechos) */}
            <div
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  onSelectClip(null, null);
                }
              }}
              className="h-14 bg-[#0B0E14] border-y border-zinc-800/80 relative flex items-center"
            >
              {/* Rótulo da Faixa */}
              <div className="absolute left-2 z-20 pointer-events-none flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm border border-zinc-700/60 text-[10px] font-semibold text-emerald-300">
                <Music className="h-3 w-3 text-emerald-400" />
                MÚSICA
              </div>

              {/* Blocos de Áudio da Música com Formas de Onda */}
              {musicTracks.map((track) => {
                const isSelected = selectedClipId === track.id && selectedTrackType === "music";
                const leftPx = track.timelineStartSecs * zoom;
                const widthPx = Math.max(24, track.durationSecs * zoom);

                return (
                  <div
                    key={track.id}
                    onMouseDown={(e) => handleMusicDrag(e, track)}
                    style={{
                      left: `${leftPx}px`,
                      width: `${widthPx}px`,
                    }}
                    className={`absolute h-11 rounded-lg border flex items-center justify-between overflow-hidden cursor-move transition-all ${
                      isSelected
                        ? "bg-gradient-to-r from-emerald-950 to-emerald-900/80 ring-2 ring-emerald-400 border-emerald-400 shadow-lg shadow-emerald-950/50 z-20"
                        : "bg-gradient-to-r from-emerald-950/60 to-zinc-900 border-emerald-600/40 hover:border-emerald-500/60 z-10"
                    }`}
                  >
                    {/* Alça de corte esquerdo da música (Trim In) */}
                    <div
                      onMouseDown={(e) => handleMusicTrimStart(e, track, "left")}
                      className="w-2 h-full bg-emerald-500/30 hover:bg-emerald-500/70 cursor-ew-resize flex items-center justify-center shrink-0 z-10"
                      title="Arrastar para cortar início da música"
                    >
                      <div className="w-0.5 h-3 bg-emerald-300 rounded" />
                    </div>

                    {/* Forma de Onda Sonora ao fundo do bloco */}
                    <AudioWaveform
                      sourcePath={track.sourcePath}
                      inPointSecs={track.inPointSecs}
                      durationSecs={track.durationSecs}
                      widthPx={widthPx}
                      heightPx={44}
                    />

                    {/* Informações do Bloco de Áudio */}
                    <div className="flex-1 px-2 min-w-0 overflow-hidden z-10 drop-shadow-md">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-200 truncate">
                        <Music className="h-3 w-3 text-emerald-400 shrink-0" />
                        <span className="truncate">{track.name}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-zinc-300 font-mono mt-0.5">
                        <span>{track.durationSecs.toFixed(1)}s</span>
                        <span>Vol: {Math.round(track.volume * 100)}%</span>
                        {track.fadeInSecs > 0 && <span>In: {track.fadeInSecs}s</span>}
                        {track.fadeOutSecs > 0 && <span>Out: {track.fadeOutSecs}s</span>}
                      </div>
                    </div>

                    {/* Alça de corte direito da música (Trim Out) */}
                    <div
                      onMouseDown={(e) => handleMusicTrimStart(e, track, "right")}
                      className="w-2 h-full bg-emerald-500/30 hover:bg-emerald-500/70 cursor-ew-resize flex items-center justify-center shrink-0 z-10"
                      title="Arrastar para cortar fim da música"
                    >
                      <div className="w-0.5 h-3 bg-emerald-300 rounded" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. Indicador de Reprodução (Agulha / Playhead) */}
          <div
            style={{ left: `${playheadSecs * zoom}px` }}
            className="absolute top-0 bottom-0 pointer-events-none z-30 flex flex-col items-center"
          >
            {/* Cabeça do Cursor */}
            <div className="w-3.5 h-3.5 bg-red-500 rotate-45 -mt-1 shadow-md shadow-red-950/80" />
            {/* Linha Vertical da Agulha */}
            <div className="w-0.5 flex-1 bg-red-500 shadow-sm shadow-red-950" />
          </div>
        </div>
      </div>

      {/* 4. Painel de Propriedades Rápidas Padronizado (Item 10) */}
      {selectedClipId && (
        <div className="h-10 px-4 bg-[#0B0D12] border-t border-zinc-800 flex items-center justify-between gap-4 text-xs shrink-0">
          {selectedTrackType === "video" && (() => {
            const clip = videoClips.find((c) => c.id === selectedClipId);
            if (!clip) return null;
            return (
              <div className="flex items-center gap-4 w-full">
                {/* Nome limitado com ellipsis e title no hover */}
                <div
                  className="max-w-[180px] shrink-0 font-semibold text-white flex items-center gap-1.5 truncate"
                  title={clip.name}
                >
                  <Film className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                  <span className="truncate">{clip.name}</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-zinc-400 text-[11px]">Volume do Jogo:</span>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={clip.isMuted ? 0 : clip.volume}
                    onChange={(e) =>
                      onUpdateClip({
                        ...clip,
                        volume: parseFloat(e.target.value),
                        isMuted: false,
                      })
                    }
                    className="w-20 h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                  />
                  <span className="font-mono text-zinc-300 text-[10px] w-8">
                    {Math.round(clip.volume * 100)}%
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => onUpdateClip({ ...clip, isMuted: !clip.isMuted })}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer shrink-0 ${
                    clip.isMuted
                      ? "bg-red-500/20 text-red-300 border border-red-500/40"
                      : "bg-zinc-800 text-zinc-300 hover:text-white"
                  }`}
                >
                  {clip.isMuted ? "Desativar Mudo" : "Silenciar Áudio"}
                </button>

                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400 ml-auto shrink-0">
                  <span>Início: {clip.inPointSecs.toFixed(1)}s</span>
                  <span>Fim: {clip.outPointSecs.toFixed(1)}s</span>
                  <span className="text-purple-300 font-bold">
                    Duração: {clip.durationSecs.toFixed(1)}s
                  </span>
                </div>
              </div>
            );
          })()}

          {selectedTrackType === "music" && (() => {
            const track = musicTracks.find((m) => m.id === selectedClipId);
            if (!track) return null;
            return (
              <div className="flex items-center gap-4 w-full">
                {/* 
                  Ordem Padronizada conforme Item 10:
                  Nome do arquivo | Volume | Fade In | Fade Out | Silenciar
                */}
                <div
                  className="max-w-[180px] shrink-0 font-semibold text-white flex items-center gap-1.5 truncate"
                  title={track.name}
                >
                  <Music className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{track.name}</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-zinc-400 text-[11px]">Volume:</span>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.05"
                    value={track.isMuted ? 0 : track.volume}
                    onChange={(e) =>
                      onUpdateMusic({
                        ...track,
                        volume: parseFloat(e.target.value),
                        isMuted: false,
                      })
                    }
                    className="w-20 h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                  />
                  <span className="font-mono text-zinc-300 text-[10px] w-8">
                    {Math.round(track.volume * 100)}%
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                  <span className="text-zinc-400">Fade In:</span>
                  <select
                    value={track.fadeInSecs}
                    onChange={(e) =>
                      onUpdateMusic({
                        ...track,
                        fadeInSecs: parseFloat(e.target.value),
                      })
                    }
                    className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs"
                  >
                    <option value="0">Sem fade</option>
                    <option value="0.5">0.5s</option>
                    <option value="1">1s</option>
                    <option value="2">2s</option>
                    <option value="3">3s</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                  <span className="text-zinc-400">Fade Out:</span>
                  <select
                    value={track.fadeOutSecs}
                    onChange={(e) =>
                      onUpdateMusic({
                        ...track,
                        fadeOutSecs: parseFloat(e.target.value),
                      })
                    }
                    className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-xs"
                  >
                    <option value="0">Sem fade</option>
                    <option value="0.5">0.5s</option>
                    <option value="1">1s</option>
                    <option value="2">2s</option>
                    <option value="3">3s</option>
                    <option value="5">5s</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => onUpdateMusic({ ...track, isMuted: !track.isMuted })}
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer shrink-0 ${
                    track.isMuted
                      ? "bg-red-500/20 text-red-300 border border-red-500/40"
                      : "bg-zinc-800 text-zinc-300 hover:text-white"
                  }`}
                >
                  {track.isMuted ? "Desativar Mudo" : "Silenciar Música"}
                </button>

                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400 ml-auto shrink-0">
                  <span>Posição: {track.timelineStartSecs.toFixed(1)}s</span>
                  <span className="text-emerald-300 font-bold">
                    Duração: {track.durationSecs.toFixed(1)}s
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
