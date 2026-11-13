import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  X,
  AlertTriangle,
  Play,
} from "lucide-react";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultOutputPath: string;
  totalDurationSecs: number;
  framingMode: "fit" | "stretch" | "fill_crop";
  onFramingChange: (mode: "fit" | "stretch" | "fill_crop") => void;
  isExporting: boolean;
  exportProgress: {
    state: string;
    progress_pct: number;
    elapsed_secs: number;
    current_fps: number;
    output_path?: string | null;
    error?: string | null;
  } | null;
  onStartExport: (options: {
    outputPath: string;
    resolutionMode: string;
    fps: number;
    bitrateKbps: number;
    framingMode: string;
  }) => void;
  onCancelExport: () => void;
}

export function ExportModal({
  isOpen,
  onClose,
  defaultOutputPath,
  totalDurationSecs,
  framingMode,
  onFramingChange,
  isExporting,
  exportProgress,
  onStartExport,
  onCancelExport,
}: ExportModalProps) {
  const [resolutionMode, setResolutionMode] = useState<string>("1080p");
  const [fps, setFps] = useState<number>(60);
  const [bitrateKbps, setBitrateKbps] = useState<number>(25000);
  const [outputPath, setOutputPath] = useState<string>(defaultOutputPath);

  if (!isOpen) return null;

  async function handleBrowseOutput() {
    try {
      const selected = await save({
        defaultPath: outputPath || "highlight_final.mp4",
        filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }],
      });
      if (typeof selected === "string" && selected.length > 0) {
        setOutputPath(selected);
      }
    } catch (e) {
      console.warn("Erro ao selecionar destino:", e);
    }
  }

  function handleStart() {
    onStartExport({
      outputPath: outputPath || defaultOutputPath,
      resolutionMode,
      fps,
      bitrateKbps,
      framingMode,
    });
  }

  const isDone = exportProgress?.state === "done";
  const isError = exportProgress?.state === "error";

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="bg-[#0E121A] border border-purple-500/40 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 bg-[#121622] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5 text-purple-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">
              Exportar Vídeo MP4 ({totalDurationSecs.toFixed(1)}s)
            </h2>
          </div>
          {!isExporting && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Corpo do Modal */}
        <div className="p-6 space-y-5 text-xs text-zinc-300">
          {/* Se estiver exportando ou concluído */}
          {isExporting || isDone || isError ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">
                  {isDone
                    ? "Exportação concluída com sucesso!"
                    : isError
                    ? "Falha durante a exportação"
                    : "Exportando montagem da timeline..."}
                </span>
                <span className="font-mono text-purple-400 font-bold">
                  {exportProgress ? Math.round(exportProgress.progress_pct) : 0}%
                </span>
              </div>

              {/* Barra de Progresso */}
              <div className="w-full h-3 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full transition-all duration-150 ${
                    isError
                      ? "bg-red-500"
                      : isDone
                      ? "bg-emerald-500"
                      : "bg-gradient-to-r from-purple-500 to-emerald-400"
                  }`}
                  style={{
                    width: `${exportProgress?.progress_pct || (isDone ? 100 : 0)}%`,
                  }}
                />
              </div>

              {/* Informações de Renderização */}
              {isExporting && exportProgress && (
                <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                  <span>Velocidade: {exportProgress.current_fps} FPS</span>
                  <span>Tempo decorrido: {exportProgress.elapsed_secs.toFixed(1)}s</span>
                </div>
              )}

              {/* Mensagem de Erro */}
              {isError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                  <span>{exportProgress?.error || "Erro desconhecido na exportação."}</span>
                </div>
              )}

              {/* Ações após conclusão */}
              {isDone && (
                <div className="pt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (exportProgress?.output_path) {
                        invoke("open_video_file", { path: exportProgress.output_path });
                      }
                    }}
                    className="flex-1 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Assistir Vídeo Exportado
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="py-2 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold transition-colors cursor-pointer"
                  >
                    Fechar
                  </button>
                </div>
              )}

              {/* Botão de Cancelar durante exportação */}
              {isExporting && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={onCancelExport}
                    className="w-full py-2 rounded-lg bg-zinc-800 hover:bg-red-500/20 hover:text-red-300 text-zinc-300 font-semibold transition-colors cursor-pointer"
                  >
                    Cancelar Exportação
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* Formulário de Configuração */
            <>
              {/* Resolução */}
              <div>
                <label className="block text-zinc-400 font-semibold mb-1.5">
                  Resolução de Saída:
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: "1080p", label: "1080p Full HD", desc: "1920x1080" },
                    { id: "720p", label: "720p HD", desc: "1280x720" },
                    { id: "1440p", label: "1440p 2K", desc: "2560x1440" },
                  ].map((res) => (
                    <button
                      key={res.id}
                      type="button"
                      onClick={() => setResolutionMode(res.id)}
                      className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                        resolutionMode === res.id
                          ? "bg-purple-600/20 border-purple-500/60 text-white shadow-sm"
                          : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                      }`}
                    >
                      <div className="font-semibold text-xs">{res.label}</div>
                      <div className="text-[10px] text-zinc-500 font-mono mt-0.5">{res.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Taxa de Quadros (FPS) e Qualidade */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 font-semibold mb-1.5">
                    Taxa de Quadros (FPS):
                  </label>
                  <select
                    value={fps}
                    onChange={(e) => setFps(parseInt(e.target.value))}
                    className="w-full bg-[#121622] border border-zinc-800 rounded-xl px-3 py-2 text-white font-medium"
                  >
                    <option value="60">60 FPS (Recomendado)</option>
                    <option value="30">30 FPS (Mais leve)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-zinc-400 font-semibold mb-1.5">Qualidade (Bitrate):</label>
                  <select
                    value={bitrateKbps}
                    onChange={(e) => setBitrateKbps(parseInt(e.target.value))}
                    className="w-full bg-[#121622] border border-zinc-800 rounded-xl px-3 py-2 text-white font-medium"
                  >
                    <option value="25000">Alta (25 Mbps) — Máxima Nitidez</option>
                    <option value="15000">Média (15 Mbps) — Equilibrada</option>
                    <option value="8000">Rápida (8 Mbps) — Arquivo Leve</option>
                  </select>
                </div>
              </div>

              {/* Enquadramento (Ajuste discreto conforme Item 9) */}
              <div>
                <label className="block text-zinc-400 font-semibold mb-1.5">
                  Modo de Enquadramento:
                </label>
                <select
                  value={framingMode}
                  onChange={(e) => onFramingChange(e.target.value as any)}
                  className="w-full bg-[#121622] border border-zinc-800 rounded-xl px-3 py-2 text-white font-medium"
                >
                  <option value="fit">Manter proporção (Padrão — Adiciona barras se necessário)</option>
                  <option value="stretch">Esticar para preencher (Sem barras — Resolução Stretched)</option>
                  <option value="fill_crop">Preencher e cortar (Sem barras — Corta laterais)</option>
                </select>
              </div>

              {/* Destino do Arquivo */}
              <div>
                <label className="block text-zinc-400 font-semibold mb-1.5">Arquivo de Saída:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={outputPath}
                    onChange={(e) => setOutputPath(e.target.value)}
                    className="flex-1 bg-[#121622] border border-zinc-800 rounded-xl px-3 py-2 text-zinc-200 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseOutput}
                    className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold transition-colors cursor-pointer shrink-0"
                  >
                    Alterar...
                  </button>
                </div>
              </div>

              {/* Botões de Ação */}
              <div className="pt-2 flex items-center justify-end gap-3 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold flex items-center gap-2 shadow-lg shadow-purple-900/30 transition-all cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  Exportar Agora
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
