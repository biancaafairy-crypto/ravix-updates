import { Film, Music, Plus, Trash2, FolderPlus, Clock } from "lucide-react";
import type { MediaAsset } from "./types";

interface MediaLibraryProps {
  assets: MediaAsset[];
  onImportVideos: () => void;
  onImportMusic: () => void;
  onAddClipToTimeline: (asset: MediaAsset) => void;
  onRemoveAsset: (assetId: string) => void;
}

function formatDuration(secs: number): string {
  if (!secs || isNaN(secs) || secs < 0) return "00:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function MediaLibrary({
  assets,
  onImportVideos,
  onImportMusic,
  onAddClipToTimeline,
  onRemoveAsset,
}: MediaLibraryProps) {
  const videoAssets = assets.filter((a) => a.kind === "video");
  const musicAssets = assets.filter((a) => a.kind === "audio");

  return (
    <aside className="w-72 bg-[#0C0F15] border-r border-zinc-800 flex flex-col shrink-0 select-none">
      {/* Header com botões de importação */}
      <div className="p-3.5 border-b border-zinc-800/80 space-y-2 bg-[#0F121A]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-white tracking-wider flex items-center gap-1.5 uppercase">
            <Film className="h-3.5 w-3.5 text-purple-400" />
            Mídias do Projeto
          </span>
          <span className="text-[11px] text-zinc-500 font-mono">
            {assets.length} {assets.length === 1 ? "arquivo" : "arquivos"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onImportVideos}
            className="px-2.5 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-200 border border-purple-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <FolderPlus className="h-3.5 w-3.5 text-purple-400" />
            + Vídeo
          </button>
          <button
            type="button"
            onClick={onImportMusic}
            className="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 border border-emerald-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <Music className="h-3.5 w-3.5 text-emerald-400" />
            + Música
          </button>
        </div>
      </div>

      {/* Lista de Arquivos */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {assets.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 text-zinc-500">
            <Film className="h-10 w-10 text-zinc-700 mb-2 stroke-1" />
            <p className="text-xs font-medium text-zinc-400">Nenhum arquivo importado</p>
            <p className="text-[11px] text-zinc-600 mt-1">
              Importe gravações do FiveM ou músicas locais para montar seu highlight.
            </p>
          </div>
        ) : (
          <>
            {/* Seção Vídeos */}
            {videoAssets.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-2 px-1 flex items-center justify-between">
                  <span>Gravações de Vídeo ({videoAssets.length})</span>
                </div>
                <div className="space-y-1.5">
                  {videoAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="group p-2 rounded-xl bg-[#121622] hover:bg-[#181D2C] border border-zinc-800/80 hover:border-purple-500/40 transition-all flex flex-col gap-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
                            <Film className="h-3.5 w-3.5 text-purple-400" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-zinc-200 truncate" title={asset.name}>
                              {asset.name}
                            </p>
                            <div className="flex items-center gap-2 text-[10px] text-zinc-400 font-mono">
                              <span className="flex items-center gap-1">
                                <Clock className="h-2.5 w-2.5" />
                                {formatDuration(asset.durationSecs)}
                              </span>
                              {asset.width > 0 && (
                                <span>
                                  {asset.width}x{asset.height}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onRemoveAsset(asset.id)}
                          className="text-zinc-600 hover:text-red-400 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="Remover da biblioteca"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onAddClipToTimeline(asset)}
                        className="w-full py-1 px-2 rounded-md bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      >
                        <Plus className="h-3 w-3" />
                        Adicionar à Timeline
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Seção Músicas */}
            {musicAssets.length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-2 px-1 flex items-center justify-between">
                  <span>Músicas & Áudios ({musicAssets.length})</span>
                </div>
                <div className="space-y-1.5">
                  {musicAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="group p-2 rounded-xl bg-[#121622] hover:bg-[#181D2C] border border-zinc-800/80 hover:border-emerald-500/40 transition-all flex flex-col gap-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
                            <Music className="h-3.5 w-3.5 text-emerald-400" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-zinc-200 truncate" title={asset.name}>
                              {asset.name}
                            </p>
                            <span className="text-[10px] text-zinc-400 font-mono">
                              {formatDuration(asset.durationSecs)}
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onRemoveAsset(asset.id)}
                          className="text-zinc-600 hover:text-red-400 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="Remover da biblioteca"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onAddClipToTimeline(asset)}
                        className="w-full py-1 px-2 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      >
                        <Plus className="h-3 w-3" />
                        Adicionar à Música
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
