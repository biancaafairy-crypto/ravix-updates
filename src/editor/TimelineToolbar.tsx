import {
  Scissors,
  Trash2,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Magnet,
} from "lucide-react";

interface TimelineToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  hasSelectedClip: boolean;
  snapping: boolean;
  zoom: number; // pixels por segundo
  onSplit: () => void;
  onTrimIn: () => void;
  onTrimOut: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleSnapping: () => void;
  onZoomChange: (zoom: number) => void;
  onResetZoom: () => void;
}

export function TimelineToolbar({
  canUndo,
  canRedo,
  hasSelectedClip,
  snapping,
  zoom,
  onSplit,
  onTrimIn,
  onTrimOut,
  onDelete,
  onUndo,
  onRedo,
  onToggleSnapping,
  onZoomChange,
  onResetZoom,
}: TimelineToolbarProps) {
  return (
    <div className="h-10 px-4 bg-[#0E1219] border-t border-b border-zinc-800 flex items-center justify-between gap-4 select-none shrink-0">
      {/* Ferramentas de Edição Principal */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!hasSelectedClip}
          onClick={onSplit}
          className="px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-purple-600/30 text-zinc-300 hover:text-purple-200 border border-zinc-700/60 hover:border-purple-500/40 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          title="Dividir clipe no cursor (Tecla S)"
        >
          <Scissors className="h-3.5 w-3.5 text-purple-400" />
          <span>Dividir</span>
          <span className="text-[10px] text-zinc-500 font-mono">S</span>
        </button>

        <button
          type="button"
          disabled={!hasSelectedClip}
          onClick={onTrimIn}
          className="px-2 py-1 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          title="Cortar início até a agulha (Tecla I)"
        >
          <span>Cortar Início</span>
          <span className="text-[10px] text-zinc-500 font-mono">I</span>
        </button>

        <button
          type="button"
          disabled={!hasSelectedClip}
          onClick={onTrimOut}
          className="px-2 py-1 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          title="Cortar fim a partir da agulha (Tecla O)"
        >
          <span>Cortar Fim</span>
          <span className="text-[10px] text-zinc-500 font-mono">O</span>
        </button>

        <div className="h-4 w-px bg-zinc-800 mx-1" />

        <button
          type="button"
          disabled={!hasSelectedClip}
          onClick={onDelete}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-all cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
          title="Excluir clipe selecionado (Del / Backspace)"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>

        <div className="h-4 w-px bg-zinc-800 mx-1" />

        {/* Histórico Desfazer / Refazer */}
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
          title="Desfazer (Ctrl+Z)"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
          title="Refazer (Ctrl+Y)"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>

        <div className="h-4 w-px bg-zinc-800 mx-1" />

        {/* Snapping Magnético */}
        <button
          type="button"
          onClick={onToggleSnapping}
          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
            snapping
              ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
          title={snapping ? "Alinhamento magnético ativo" : "Alinhamento magnético desligado"}
        >
          <Magnet className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Zoom da Timeline */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onZoomChange(Math.max(10, zoom - 15))}
          className="p-1 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
          title="Diminuir zoom da timeline"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>

        <input
          type="range"
          min="10"
          max="120"
          step="5"
          value={zoom}
          onChange={(e) => onZoomChange(parseInt(e.target.value))}
          className="w-24 h-1.5 accent-purple-500 bg-zinc-700 rounded-lg cursor-pointer"
        />

        <button
          type="button"
          onClick={() => onZoomChange(Math.min(120, zoom + 15))}
          className="p-1 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
          title="Aumentar zoom da timeline"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={onResetZoom}
          className="px-1.5 py-0.5 rounded text-[10px] text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors cursor-pointer font-mono"
          title="Redefinir zoom"
        >
          {zoom}px/s
        </button>
      </div>
    </div>
  );
}
