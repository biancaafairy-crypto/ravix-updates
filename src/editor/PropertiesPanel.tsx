import { useState } from "react";
import {
  SlidersHorizontal,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  Volume2,
  VolumeX,
  Video,
  Music,
  Layers,
  Sparkles,
} from "lucide-react";
import type { TimelineClip, TimelineAudioTrack, MediaAsset } from "./types";

interface PropertiesPanelProps {
  isOpen: boolean;
  onToggleOpen: () => void;
  selectedTrackType: "video" | "music" | null;
  selectedClip: TimelineClip | null;
  selectedMusic: TimelineAudioTrack | null;
  assets: MediaAsset[];
  onUpdateClip: (clipId: string, updates: Partial<TimelineClip>) => void;
  onUpdateMusic: (trackId: string, updates: Partial<TimelineAudioTrack>) => void;
  onResetClipTransform: (clipId: string) => void;
  onResetClipCrop: (clipId: string) => void;
}

function formatTime(secs: number): string {
  if (isNaN(secs) || secs < 0) return "00:00:00.0";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms}`;
}

export function PropertiesPanel({
  isOpen,
  onToggleOpen,
  selectedTrackType,
  selectedClip,
  selectedMusic,
  assets,
  onUpdateClip,
  onUpdateMusic,
  onResetClipTransform,
  onResetClipCrop,
}: PropertiesPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<"visual" | "audio">("visual");
  const [linkScaleAspect, setLinkScaleAspect] = useState<boolean>(true);

  // Se o painel estiver recolhido, exibe apenas uma barra lateral discreta com botão para expandir
  if (!isOpen) {
    return (
      <div className="w-10 shrink-0 bg-[#0A0D14] border-l border-zinc-800/80 flex flex-col items-center py-3 select-none">
        <button
          type="button"
          onClick={onToggleOpen}
          className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          title="Expandir Painel de Edição"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="mt-8 [writing-mode:vertical-rl] rotate-180 text-[11px] font-bold text-zinc-500 tracking-wider uppercase flex items-center gap-1.5">
          <SlidersHorizontal className="h-3 w-3 inline rotate-90" />
          <span>Propriedades</span>
        </div>
      </div>
    );
  }

  // Obter metadados do ativo original caso clipe de vídeo esteja selecionado
  const clipAsset = selectedClip
    ? assets.find((a) => a.id === selectedClip.assetId || a.path === selectedClip.sourcePath)
    : null;

  return (
    <aside className="w-72 shrink-0 bg-[#0B0E15] border-l border-zinc-800/80 flex flex-col select-none overflow-hidden">
      {/* Cabeçalho do Painel */}
      <div className="p-3.5 border-b border-zinc-800/80 bg-[#0E121B] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-purple-400" />
          <h2 className="text-xs font-bold text-white uppercase tracking-wider">
            Propriedades
          </h2>
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          title="Recolher Painel de Edição"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Conteúdo Contextual */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {selectedTrackType === "video" && selectedClip ? (
          /* =================== PROPRIEDADES DO VÍDEO =================== */
          <div className="space-y-4">
            {/* Header do Elemento */}
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-purple-950/20 border border-purple-500/30">
              <Video className="h-4 w-4 text-purple-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white truncate text-xs" title={selectedClip.name}>
                  {selectedClip.name}
                </div>
                <div className="text-[10px] text-purple-300 font-mono mt-0.5">
                  Clipe de Vídeo
                </div>
              </div>
            </div>

            {/* Sub-Tabs: Visual & Áudio */}
            <div className="flex rounded-lg bg-zinc-900/80 p-0.5 border border-zinc-800">
              <button
                type="button"
                onClick={() => setActiveSubTab("visual")}
                className={`flex-1 py-1 text-center rounded-md text-[11px] font-semibold transition-all cursor-pointer ${
                  activeSubTab === "visual"
                    ? "bg-purple-600 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Visual & Posição
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab("audio")}
                className={`flex-1 py-1 text-center rounded-md text-[11px] font-semibold transition-all cursor-pointer ${
                  activeSubTab === "audio"
                    ? "bg-purple-600 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Áudio do Clipe
              </button>
            </div>

            {activeSubTab === "visual" ? (
              <div className="space-y-3.5">
                {/* Informações Gerais */}
                <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-2">
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>Posição na Montagem:</span>
                    <span className="font-mono text-zinc-200 font-semibold">
                      {formatTime(selectedClip.timelineStartSecs)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>Duração:</span>
                    <span className="font-mono text-zinc-200 font-semibold">
                      {selectedClip.durationSecs.toFixed(2)}s
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                    <span>Resolução Nativa:</span>
                    <span className="font-mono text-purple-300 font-semibold">
                      {clipAsset?.width && clipAsset?.height
                        ? `${clipAsset.width}×${clipAsset.height}`
                        : "Detectando..."}
                    </span>
                  </div>
                </div>

                {/* Enquadramento */}
                <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-1.5">
                  <label className="block text-[11px] font-semibold text-zinc-300">
                    Modo de Enquadramento
                  </label>
                  <select
                    value={selectedClip.framingMode ?? "stretch"}
                    onChange={(e) =>
                      onUpdateClip(selectedClip.id, {
                        framingMode: e.target.value as "stretch" | "fit" | "fill_crop",
                      })
                    }
                    className="w-full rounded-lg bg-[#0A0D14] border border-zinc-700/80 px-2.5 py-1.5 text-xs text-white cursor-pointer"
                  >
                    <option value="stretch">Estender à tela (Stretch)</option>
                    <option value="fit">Ajustar com barras (Fit)</option>
                    <option value="fill_crop">Preencher e cortar (Crop)</option>
                  </select>
                </div>

                {/* Escala e Posição (Manipulação Visual Direcional) */}
                <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-300">
                      Transformação Visual (8 Alças)
                    </span>
                    <button
                      type="button"
                      onClick={() => setLinkScaleAspect(!linkScaleAspect)}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer border ${
                        linkScaleAspect
                          ? "bg-purple-600/30 text-purple-300 border-purple-500/50"
                          : "bg-zinc-800 text-zinc-400 border-zinc-700"
                      }`}
                      title={linkScaleAspect ? "Proporção vinculada (X e Y juntos)" : "Escala livre (X e Y independentes)"}
                    >
                      {linkScaleAspect ? "Proporção Fixa" : "Escala Livre"}
                    </button>
                  </div>

                  {/* Escala X (Largura) */}
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                      <span>Largura (Escala X):</span>
                      <span className="font-mono text-purple-300 font-bold">
                        {Math.round((selectedClip.scaleX ?? selectedClip.scale ?? 1.0) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.2"
                      max="3.0"
                      step="0.05"
                      value={selectedClip.scaleX ?? selectedClip.scale ?? 1.0}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (linkScaleAspect) {
                          onUpdateClip(selectedClip.id, { scaleX: val, scaleY: val, scale: val });
                        } else {
                          onUpdateClip(selectedClip.id, { scaleX: val });
                        }
                      }}
                      className="w-full h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                    />
                  </div>

                  {/* Escala Y (Altura) */}
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                      <span>Altura (Escala Y):</span>
                      <span className="font-mono text-purple-300 font-bold">
                        {Math.round((selectedClip.scaleY ?? selectedClip.scale ?? 1.0) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.2"
                      max="3.0"
                      step="0.05"
                      value={selectedClip.scaleY ?? selectedClip.scale ?? 1.0}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (linkScaleAspect) {
                          onUpdateClip(selectedClip.id, { scaleX: val, scaleY: val, scale: val });
                        } else {
                          onUpdateClip(selectedClip.id, { scaleY: val });
                        }
                      }}
                      className="w-full h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                    />
                  </div>

                  {/* Offset X e Y */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Offset X:</span>
                        <span className="font-mono text-zinc-300">
                          {Math.round(selectedClip.positionX ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="-50"
                        max="50"
                        step="1"
                        value={selectedClip.positionX ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            positionX: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Offset Y:</span>
                        <span className="font-mono text-zinc-300">
                          {Math.round(selectedClip.positionY ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="-50"
                        max="50"
                        step="1"
                        value={selectedClip.positionY ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            positionY: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Botão Restaurar Padrão de Transformação */}
                  <button
                    type="button"
                    onClick={() => onResetClipTransform(selectedClip.id)}
                    className="w-full py-1.5 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restaurar Padrão (100%, 0, 0)
                  </button>
                </div>

                {/* Recorte Manual de Bordas (Crop Tool) — ETAPA 5 */}
                <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-300">
                      Recorte Manual de Bordas (Crop)
                    </span>
                    <span className="text-[10px] font-mono text-emerald-300">
                      {(selectedClip.cropLeft || selectedClip.cropRight || selectedClip.cropTop || selectedClip.cropBottom)
                        ? "Personalizado"
                        : "0%"}
                    </span>
                  </div>

                  <p className="text-[10px] text-zinc-400 leading-snug bg-black/30 p-2 rounded-lg border border-zinc-800">
                    <strong className="text-zinc-300">Barras pretas:</strong> Se o vídeo original veio gravado com faixas embutidas (ex: FiveM 4:3 esticado sem preenchimento completo), use os cortes abaixo para eliminá-las da prévia e do MP4 final.
                  </p>

                  <div className="grid grid-cols-2 gap-2.5">
                    {/* Esquerda */}
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Esquerda:</span>
                        <span className="font-mono text-emerald-300">
                          {Math.round(selectedClip.cropLeft ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="49"
                        step="1"
                        value={selectedClip.cropLeft ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            cropLeft: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>

                    {/* Direita */}
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Direita:</span>
                        <span className="font-mono text-emerald-300">
                          {Math.round(selectedClip.cropRight ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="49"
                        step="1"
                        value={selectedClip.cropRight ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            cropRight: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>

                    {/* Topo */}
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Topo:</span>
                        <span className="font-mono text-emerald-300">
                          {Math.round(selectedClip.cropTop ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="49"
                        step="1"
                        value={selectedClip.cropTop ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            cropTop: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>

                    {/* Base */}
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                        <span>Base:</span>
                        <span className="font-mono text-emerald-300">
                          {Math.round(selectedClip.cropBottom ?? 0)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="49"
                        step="1"
                        value={selectedClip.cropBottom ?? 0}
                        onChange={(e) =>
                          onUpdateClip(selectedClip.id, {
                            cropBottom: parseFloat(e.target.value),
                          })
                        }
                        className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onResetClipCrop(selectedClip.id)}
                    className="w-full py-1.5 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restaurar Recorte (0%, 0%, 0%, 0%)
                  </button>
                </div>

                {/* Futuras Ferramentas (Preparado para V0.4.0) */}
                <div className="p-3 rounded-xl bg-[#0F131C] border border-dashed border-zinc-800 space-y-1.5 opacity-60">
                  <div className="flex items-center gap-1.5 text-zinc-400 font-semibold text-[11px]">
                    <Sparkles className="h-3 w-3 text-purple-400" />
                    <span>Filtros & Efeitos de Cor</span>
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-snug">
                    Brilho, contraste, saturação e motion blur para clipes de highlight. Em preparação para a V0.4.0.
                  </p>
                </div>
              </div>
            ) : (
              /* Áudio do Vídeo */
              <div className="space-y-3.5">
                <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-zinc-300">
                      Volume da Gravação
                    </span>
                    <span className="font-mono text-purple-300 font-bold text-xs">
                      {Math.round((selectedClip.isMuted ? 0 : selectedClip.volume) * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2.0"
                    step="0.05"
                    value={selectedClip.isMuted ? 0 : selectedClip.volume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      onUpdateClip(selectedClip.id, {
                        volume: v,
                        isMuted: v === 0,
                      });
                    }}
                    className="w-full h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
                  />

                  <button
                    type="button"
                    onClick={() =>
                      onUpdateClip(selectedClip.id, { isMuted: !selectedClip.isMuted })
                    }
                    className={`w-full py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                      selectedClip.isMuted
                        ? "bg-red-500/20 text-red-300 border border-red-500/40"
                        : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                    }`}
                  >
                    {selectedClip.isMuted ? (
                      <>
                        <VolumeX className="h-3.5 w-3.5 text-red-400" />
                        Áudio Silenciado (Desmutar)
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3.5 w-3.5 text-zinc-400" />
                        Silenciar Áudio Original
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : selectedTrackType === "music" && selectedMusic ? (
          /* =================== PROPRIEDADES DA MÚSICA =================== */
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-emerald-950/20 border border-emerald-500/30">
              <Music className="h-4 w-4 text-emerald-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white truncate text-xs" title={selectedMusic.name}>
                  {selectedMusic.name}
                </div>
                <div className="text-[10px] text-emerald-300 font-mono mt-0.5">
                  Faixa de Música / BGM
                </div>
              </div>
            </div>

            {/* Informações Gerais */}
            <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-2">
              <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                <span>Início na Timeline:</span>
                <span className="font-mono text-zinc-200 font-semibold">
                  {formatTime(selectedMusic.timelineStartSecs)}
                </span>
              </div>
              <div className="flex items-center justify-between text-zinc-400 text-[11px]">
                <span>Duração do Trecho:</span>
                <span className="font-mono text-zinc-200 font-semibold">
                  {selectedMusic.durationSecs.toFixed(2)}s
                </span>
              </div>
            </div>

            {/* Volume da Música */}
            <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-300">Volume</span>
                <span className="font-mono text-emerald-300 font-bold text-xs">
                  {Math.round((selectedMusic.isMuted ? 0 : selectedMusic.volume) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="2.0"
                step="0.05"
                value={selectedMusic.isMuted ? 0 : selectedMusic.volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  onUpdateMusic(selectedMusic.id, {
                    volume: v,
                    isMuted: v === 0,
                  });
                }}
                className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
              />

              <button
                type="button"
                onClick={() =>
                  onUpdateMusic(selectedMusic.id, { isMuted: !selectedMusic.isMuted })
                }
                className={`w-full py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  selectedMusic.isMuted
                    ? "bg-red-500/20 text-red-300 border border-red-500/40"
                    : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                }`}
              >
                {selectedMusic.isMuted ? (
                  <>
                    <VolumeX className="h-3.5 w-3.5 text-red-400" />
                    Música Silenciada (Desmutar)
                  </>
                ) : (
                  <>
                    <Volume2 className="h-3.5 w-3.5 text-zinc-400" />
                    Silenciar Música
                  </>
                )}
              </button>
            </div>

            {/* Fade In & Fade Out */}
            <div className="p-3 rounded-xl bg-[#121622] border border-zinc-800/80 space-y-3">
              <span className="text-[11px] font-semibold text-zinc-300 block">
                Transições de Áudio (Fade)
              </span>

              <div>
                <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                  <span>Fade-In (Entrada Suave):</span>
                  <span className="font-mono text-emerald-300">
                    {selectedMusic.fadeInSecs.toFixed(1)}s
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="5.0"
                  step="0.1"
                  value={selectedMusic.fadeInSecs}
                  onChange={(e) =>
                    onUpdateMusic(selectedMusic.id, {
                      fadeInSecs: parseFloat(e.target.value),
                    })
                  }
                  className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                  <span>Fade-Out (Saída Suave):</span>
                  <span className="font-mono text-emerald-300">
                    {selectedMusic.fadeOutSecs.toFixed(1)}s
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="5.0"
                  step="0.1"
                  value={selectedMusic.fadeOutSecs}
                  onChange={(e) =>
                    onUpdateMusic(selectedMusic.id, {
                      fadeOutSecs: parseFloat(e.target.value),
                    })
                  }
                  className="w-full h-1.5 accent-emerald-500 bg-zinc-700 rounded-lg cursor-pointer"
                />
              </div>
            </div>
          </div>
        ) : (
          /* =================== ESTADO VAZIO (NENHUM ELEMENTO SELECIONADO) =================== */
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-zinc-500 space-y-3">
            <div className="p-3.5 rounded-2xl bg-zinc-900/80 border border-zinc-800">
              <Layers className="h-7 w-7 text-zinc-600 stroke-1" />
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-300">
                Nenhum elemento selecionado
              </p>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                Clique em um clipe de vídeo ou faixa de música na timeline para editar enquadramento, escala, posição ou volume.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
