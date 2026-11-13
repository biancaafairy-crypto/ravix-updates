import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Download,
  FolderOpen,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type {
  MediaAsset,
  TimelineClip,
  TimelineAudioTrack,
  RavixProject,
  TimelineExportConfig,
} from "./types";
import { useTimelineHistory } from "./useTimelineHistory";
import { MediaLibrary } from "./MediaLibrary";
import { VideoPreview } from "./VideoPreview";
import { TimelineToolbar } from "./TimelineToolbar";
import { Timeline } from "./Timeline";
import { ExportModal } from "./ExportModal";

interface VideoEditorViewProps {
  initialVideoPath?: string | null;
  onClearInitialVideo?: () => void;
}

export function VideoEditorView({
  initialVideoPath,
  onClearInitialVideo,
}: VideoEditorViewProps) {
  const [projectName, setProjectName] = useState("Meu Highlight FiveM");
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [framingMode, setFramingMode] = useState<"fit" | "stretch" | "fill_crop">("fit");
  const [zoom, setZoom] = useState<number>(35); // pixels por segundo
  const [snapping, setSnapping] = useState<boolean>(true);

  // Histórico de Timeline (Clipes de Vídeo e Faixas de Música)
  const {
    state: timelineState,
    canUndo,
    canRedo,
    pushState,
    undo,
    redo,
    reset: resetHistory,
  } = useTimelineHistory({ videoClips: [], musicTracks: [] });

  const { videoClips, musicTracks } = timelineState;

  // Estado da Agulha (Playhead) e Reprodução
  const [playheadSecs, setPlayheadSecs] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTrackType, setSelectedTrackType] = useState<"video" | "music" | null>(null);

  // Estado do Modal de Exportação
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<any>(null);

  // Notificação de Interface
  const [editorNotice, setEditorNotice] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  // Duração Total da Sequência de Vídeo na Timeline
  const totalDurationSecs = videoClips.reduce((acc, c) => acc + c.durationSecs, 0);

  // Efeito de Reprodução da Timeline (Loop de Relógio de Alta Precisão)
  const lastTimeRef = useRef<number>(performance.now());
  useEffect(() => {
    let animId: number;
    if (isPlaying) {
      lastTimeRef.current = performance.now();
      const tick = () => {
        const now = performance.now();
        const deltaSecs = (now - lastTimeRef.current) / 1000;
        lastTimeRef.current = now;

        setPlayheadSecs((prev) => {
          const next = prev + deltaSecs;
          if (next >= totalDurationSecs) {
            setIsPlaying(false);
            return totalDurationSecs;
          }
          return next;
        });

        animId = requestAnimationFrame(tick);
      };
      animId = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, totalDurationSecs]);

  // Carregar vídeo inicial passado da aba do Gravador (se houver)
  useEffect(() => {
    if (initialVideoPath) {
      importSingleVideo(initialVideoPath);
      if (onClearInitialVideo) onClearInitialVideo();
    }
  }, [initialVideoPath]);

  // Listener para eventos de progresso de exportação
  useEffect(() => {
    const unlisten = listen<any>("export-progress", (ev) => {
      setExportProgress(ev.payload);
      if (
        ev.payload.state === "done" ||
        ev.payload.state === "error" ||
        ev.payload.state === "cancelled"
      ) {
        setIsExporting(false);
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  // Atalhos de teclado no Editor (Espaço, S, I, O, Del, Ctrl+Z, Ctrl+Y)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignorar atalhos se o usuário estiver digitando em um input
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.code === "KeyS") {
        e.preventDefault();
        handleSplitAtPlayhead();
      } else if (e.code === "KeyI") {
        e.preventDefault();
        handleTrimIn();
      } else if (e.code === "KeyO") {
        e.preventDefault();
        handleTrimOut();
      } else if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.ctrlKey && e.code === "KeyZ") {
        e.preventDefault();
        if (canUndo) undo();
      } else if (e.ctrlKey && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
        e.preventDefault();
        if (canRedo) redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Re-calcular posições sequenciais de início de cada clipe
  const recalculateStartTimes = (clips: TimelineClip[]): TimelineClip[] => {
    let currentStart = 0;
    return clips.map((c) => {
      const dur = Math.max(0.1, c.outPointSecs - c.inPointSecs);
      const updated = {
        ...c,
        timelineStartSecs: currentStart,
        durationSecs: dur,
      };
      currentStart += dur;
      return updated;
    });
  };

  // Importar Vídeos via Dialog
  async function handleImportVideos() {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Vídeos", extensions: ["mp4", "mov", "mkv", "avi", "webm"] }],
      });
      if (Array.isArray(selected)) {
        for (const filePath of selected) {
          await importSingleVideo(filePath);
        }
      } else if (typeof selected === "string") {
        await importSingleVideo(selected);
      }
    } catch (e) {
      setEditorNotice({ type: "err", text: `Erro ao importar vídeo: ${e}` });
    }
  }

  // Importar Música via Dialog
  async function handleImportMusic() {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Áudios e Músicas", extensions: ["mp3", "wav", "aac", "m4a", "ogg", "flac"] },
        ],
      });
      if (typeof selected === "string" && selected.length > 0) {
        const meta = await invoke<any>("get_media_metadata", { path: selected });
        const newAsset: MediaAsset = {
          id: meta.id,
          name: meta.name,
          path: meta.path,
          kind: "audio",
          durationSecs: meta.durationSecs,
          width: 0,
          height: 0,
          fps: 0,
          audioChannels: meta.audioChannels,
          audioSampleRate: meta.audioSampleRate,
          sizeBytes: meta.sizeBytes,
        };
        setAssets((prev) => [...prev, newAsset]);
        // Adicionar automaticamente à trilha de música
        handleAddClipToTimeline(newAsset);
        setEditorNotice({ type: "ok", text: `Música '${meta.name}' importada com sucesso.` });
      }
    } catch (e) {
      setEditorNotice({ type: "err", text: `Erro ao importar música: ${e}` });
    }
  }

  async function importSingleVideo(filePath: string) {
    try {
      const meta = await invoke<any>("get_media_metadata", { path: filePath });
      const newAsset: MediaAsset = {
        id: meta.id,
        name: meta.name,
        path: meta.path,
        kind: "video",
        durationSecs: meta.durationSecs,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        audioChannels: meta.audioChannels,
        audioSampleRate: meta.audioSampleRate,
        sizeBytes: meta.sizeBytes,
      };

      setAssets((prev) => {
        if (prev.some((a) => a.path === newAsset.path)) return prev;
        return [...prev, newAsset];
      });

      // Se a timeline estiver vazia, adiciona automaticamente o primeiro vídeo
      if (videoClips.length === 0) {
        handleAddClipToTimeline(newAsset);
      }
    } catch (e) {
      setEditorNotice({ type: "err", text: `Falha ao ler gravação: ${e}` });
    }
  }

  // Adicionar Clipe da Biblioteca à Timeline
  function handleAddClipToTimeline(asset: MediaAsset) {
    if (asset.kind === "video") {
      const newClip: TimelineClip = {
        id: `clip_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        assetId: asset.id,
        sourcePath: asset.path,
        name: asset.name,
        timelineStartSecs: totalDurationSecs,
        inPointSecs: 0,
        outPointSecs: asset.durationSecs,
        durationSecs: asset.durationSecs,
        volume: 1.0,
        isMuted: false,
      };
      const nextClips = recalculateStartTimes([...videoClips, newClip]);
      pushState({ videoClips: nextClips, musicTracks });
      setSelectedClipId(newClip.id);
      setSelectedTrackType("video");
      setEditorNotice({
        type: "ok",
        text: `Gravação '${asset.name}' adicionada à timeline.`,
      });
    } else if (asset.kind === "audio") {
      const newTrack: TimelineAudioTrack = {
        id: `music_${Date.now()}`,
        assetId: asset.id,
        sourcePath: asset.path,
        name: asset.name,
        timelineStartSecs: 0,
        inPointSecs: 0,
        durationSecs: asset.durationSecs,
        volume: 0.8,
        isMuted: false,
        fadeInSecs: 1.0,
        fadeOutSecs: 2.0,
      };
      pushState({ videoClips, musicTracks: [...musicTracks, newTrack] });
      setSelectedClipId(newTrack.id);
      setSelectedTrackType("music");
      setEditorNotice({
        type: "ok",
        text: `Música '${asset.name}' adicionada à faixa de áudio.`,
      });
    }
  }

  // Remover Ativo da Biblioteca
  function handleRemoveAsset(assetId: string) {
    setAssets((prev) => prev.filter((a) => a.id !== assetId));
  }

  // 1. DIVIDIR CLIPE NO CURSOR (Split)
  function handleSplitAtPlayhead() {
    const clipIndex = videoClips.findIndex(
      (c) =>
        playheadSecs > c.timelineStartSecs + 0.1 &&
        playheadSecs < c.timelineStartSecs + c.durationSecs - 0.1
    );

    if (clipIndex === -1) {
      setEditorNotice({
        type: "err",
        text: "Posicione a agulha sobre um clipe de vídeo para dividir.",
      });
      return;
    }

    const clip = videoClips[clipIndex];
    const relSecs = playheadSecs - clip.timelineStartSecs;
    const splitPoint = clip.inPointSecs + relSecs;

    const leftClip: TimelineClip = {
      ...clip,
      id: `clip_${Date.now()}_left`,
      outPointSecs: splitPoint,
      durationSecs: splitPoint - clip.inPointSecs,
    };

    const rightClip: TimelineClip = {
      ...clip,
      id: `clip_${Date.now()}_right`,
      inPointSecs: splitPoint,
      durationSecs: clip.outPointSecs - splitPoint,
    };

    const nextClips = [...videoClips];
    nextClips.splice(clipIndex, 1, leftClip, rightClip);
    const updated = recalculateStartTimes(nextClips);
    pushState({ videoClips: updated, musicTracks });
    setSelectedClipId(rightClip.id);
    setSelectedTrackType("video");
    setEditorNotice({ type: "ok", text: "Clipe dividido com sucesso em 2 trechos." });
  }

  // 2. CORTAR INÍCIO ATÉ A AGULHA (Trim In)
  function handleTrimIn() {
    const clipIndex = videoClips.findIndex((c) => c.id === selectedClipId);
    if (clipIndex === -1) return;
    const clip = videoClips[clipIndex];
    const relSecs = playheadSecs - clip.timelineStartSecs;
    if (relSecs <= 0 || relSecs >= clip.durationSecs - 0.2) return;

    const newIn = clip.inPointSecs + relSecs;
    const updatedClip = {
      ...clip,
      inPointSecs: newIn,
      durationSecs: clip.outPointSecs - newIn,
    };

    const nextClips = [...videoClips];
    nextClips[clipIndex] = updatedClip;
    const updated = recalculateStartTimes(nextClips);
    pushState({ videoClips: updated, musicTracks });
    setEditorNotice({ type: "ok", text: "Início do clipe cortado." });
  }

  // 3. CORTAR FIM A PARTIR DA AGULHA (Trim Out)
  function handleTrimOut() {
    const clipIndex = videoClips.findIndex((c) => c.id === selectedClipId);
    if (clipIndex === -1) return;
    const clip = videoClips[clipIndex];
    const relSecs = playheadSecs - clip.timelineStartSecs;
    if (relSecs <= 0.2 || relSecs >= clip.durationSecs) return;

    const newOut = clip.inPointSecs + relSecs;
    const updatedClip = {
      ...clip,
      outPointSecs: newOut,
      durationSecs: newOut - clip.inPointSecs,
    };

    const nextClips = [...videoClips];
    nextClips[clipIndex] = updatedClip;
    const updated = recalculateStartTimes(nextClips);
    pushState({ videoClips: updated, musicTracks });
    setEditorNotice({ type: "ok", text: "Final do clipe cortado." });
  }

  // 4. EXCLUIR CLIPE SELECIONADO (Delete)
  function handleDeleteSelected() {
    if (!selectedClipId) return;

    if (selectedTrackType === "video") {
      const nextClips = videoClips.filter((c) => c.id !== selectedClipId);
      const updated = recalculateStartTimes(nextClips);
      pushState({ videoClips: updated, musicTracks });
      setSelectedClipId(null);
      setEditorNotice({ type: "ok", text: "Trecho excluído da montagem." });
    } else if (selectedTrackType === "music") {
      const nextMusic = musicTracks.filter((m) => m.id !== selectedClipId);
      pushState({ videoClips, musicTracks: nextMusic });
      setSelectedClipId(null);
      setEditorNotice({ type: "ok", text: "Música removida da trilha." });
    }
  }

  // Atualizar Clipe pelo Trim Manual na Timeline
  function handleUpdateClip(updatedClip: TimelineClip) {
    const nextClips = videoClips.map((c) => (c.id === updatedClip.id ? updatedClip : c));
    const recalculated = recalculateStartTimes(nextClips);
    pushState({ videoClips: recalculated, musicTracks });
  }

  // Atualizar Faixa de Música
  function handleUpdateMusic(updatedMusic: TimelineAudioTrack) {
    const nextMusic = musicTracks.map((m) =>
      m.id === updatedMusic.id ? updatedMusic : m
    );
    pushState({ videoClips, musicTracks: nextMusic });
  }

  // Reorganizar Clipes por Arraste
  function handleReorderClips(fromIdx: number, toIdx: number) {
    const nextClips = [...videoClips];
    const [moved] = nextClips.splice(fromIdx, 1);
    nextClips.splice(toIdx, 0, moved);
    const updated = recalculateStartTimes(nextClips);
    pushState({ videoClips: updated, musicTracks });
    setEditorNotice({ type: "ok", text: "Ordem dos clipes reorganizada." });
  }

  // 5. NOVO PROJETO
  function handleNewProject() {
    if (videoClips.length > 0 || assets.length > 0) {
      if (!window.confirm("Deseja criar um novo projeto? As alterações não salvas serão perdidas.")) {
        return;
      }
    }
    setProjectName("Meu Highlight FiveM");
    setAssets([]);
    resetHistory({ videoClips: [], musicTracks: [] });
    setPlayheadSecs(0);
    setIsPlaying(false);
    setSelectedClipId(null);
    setEditorNotice({ type: "ok", text: "Novo projeto criado." });
  }

  // 6. SALVAR PROJETO (.ravixproj)
  async function handleSaveProject() {
    try {
      const selected = await save({
        defaultPath: `${projectName.replace(/[^a-zA-Z0-9_-]/g, "_")}.ravixproj`,
        filters: [{ name: "Projeto RAVIX", extensions: ["ravixproj"] }],
      });
      if (typeof selected === "string" && selected.length > 0) {
        const projectData: RavixProject = {
          version: "1.0",
          name: projectName,
          assets,
          videoClips,
          musicTracks,
          framingMode,
          resolutionMode: "1080p",
          fps: 60,
          bitrateKbps: 25000,
        };
        const jsonStr = JSON.stringify(projectData, null, 2);
        await invoke("save_ravix_project", { path: selected, projectJson: jsonStr });
        setEditorNotice({ type: "ok", text: `Projeto salvo com sucesso em: ${selected}` });
      }
    } catch (e) {
      setEditorNotice({ type: "err", text: `Erro ao salvar projeto: ${e}` });
    }
  }

  // 7. ABRIR PROJETO (.ravixproj)
  async function handleOpenProject() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Projeto RAVIX", extensions: ["ravixproj"] }],
      });
      if (typeof selected === "string" && selected.length > 0) {
        const jsonStr = await invoke<string>("load_ravix_project", { path: selected });
        const proj: RavixProject = JSON.parse(jsonStr);

        // Verificar existência dos arquivos no disco
        const allPaths = [
          ...proj.assets.map((a) => a.path),
          ...proj.videoClips.map((c) => c.sourcePath),
        ];
        const existResults = await invoke<boolean[]>("check_media_files_exist", {
          paths: allPaths,
        });
        const hasMissing = existResults.some((exists) => !exists);

        if (hasMissing) {
          setEditorNotice({
            type: "err",
            text: "Aviso: alguns arquivos originais deste projeto foram movidos ou excluídos.",
          });
        }

        setProjectName(proj.name || "Projeto Carregado");
        setAssets(proj.assets || []);
        if (proj.framingMode) setFramingMode(proj.framingMode);
        resetHistory({
          videoClips: proj.videoClips || [],
          musicTracks: proj.musicTracks || [],
        });
        setPlayheadSecs(0);
        setIsPlaying(false);
        setEditorNotice({ type: "ok", text: `Projeto '${proj.name}' aberto com sucesso.` });
      }
    } catch (e) {
      setEditorNotice({ type: "err", text: `Falha ao carregar projeto: ${e}` });
    }
  }

  // 8. DISPARAR EXPORTAÇÃO REAL DA TIMELINE
  async function handleStartExport(options: {
    outputPath: string;
    resolutionMode: string;
    fps: number;
    bitrateKbps: number;
    framingMode: string;
  }) {
    if (videoClips.length === 0) {
      setEditorNotice({
        type: "err",
        text: "Adicione ao menos um clipe à timeline antes de exportar.",
      });
      return;
    }

    try {
      setIsExporting(true);
      setExportProgress({
        state: "exporting",
        progress_pct: 0,
        elapsed_secs: 0,
        current_fps: 0,
      });

      const exportConfig: TimelineExportConfig = {
        outputPath: options.outputPath,
        resolutionMode: options.resolutionMode,
        framingMode: options.framingMode,
        fps: options.fps,
        bitrateKbps: options.bitrateKbps,
        clips: videoClips.map((c) => ({
          id: c.id,
          sourcePath: c.sourcePath,
          inPointSecs: c.inPointSecs,
          outPointSecs: c.outPointSecs,
          volume: c.volume,
          isMuted: c.isMuted,
        })),
        musicTracks: musicTracks.map((m) => ({
          id: m.id,
          sourcePath: m.sourcePath,
          startTimelineSecs: m.timelineStartSecs,
          inPointSecs: m.inPointSecs,
          durationSecs: m.durationSecs,
          volume: m.volume,
          isMuted: m.isMuted,
          fadeInSecs: m.fadeInSecs,
          fadeOutSecs: m.fadeOutSecs,
        })),
      };

      await invoke("start_timeline_export", { config: exportConfig });
    } catch (e) {
      setIsExporting(false);
      setExportProgress({
        state: "error",
        error: String(e),
        progress_pct: 0,
        elapsed_secs: 0,
        current_fps: 0,
      });
    }
  }

  function handleCancelExport() {
    invoke("cancel_timeline_export").catch(() => {});
    setIsExporting(false);
  }

  // Caminho de exportação sugerido padrão
  const suggestedOutputPath = `C:\\Users\\Santarosa\\Videos\\RAVIX\\${projectName.replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  )}_export_1080p.mp4`;

  return (
    <div className="flex-1 flex flex-col bg-[#07090D] overflow-hidden select-none">
      {/* 1. Barra Superior de Projetos & Ações */}
      <div className="h-12 px-6 bg-[#0B0E14] border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="text-sm font-bold text-white bg-transparent hover:bg-zinc-800/60 focus:bg-zinc-900 border border-transparent focus:border-purple-500/50 rounded-lg px-2 py-1 outline-none transition-all"
            title="Clique para renomear o projeto"
          />
          <span className="text-[11px] text-zinc-500 font-mono">
            {videoClips.length} {videoClips.length === 1 ? "clipe" : "clipes"} (
            {totalDurationSecs.toFixed(1)}s)
          </span>
        </div>

        {/* Notificação Rápida */}
        {editorNotice && (
          <div
            className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all animate-fade-in ${
              editorNotice.type === "ok"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/15 text-red-300 border border-red-500/30"
            }`}
          >
            {editorNotice.type === "ok" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
            )}
            <span>{editorNotice.text}</span>
          </div>
        )}

        {/* Botões do Projeto */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNewProject}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Novo Projeto Vazio"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Novo
          </button>
          <button
            type="button"
            onClick={handleOpenProject}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Abrir Projeto (.ravixproj)"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Abrir...
          </button>
          <button
            type="button"
            onClick={handleSaveProject}
            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Salvar Projeto (.ravixproj)"
          >
            <Save className="h-3.5 w-3.5" />
            Salvar
          </button>

          <div className="h-5 w-px bg-zinc-800 mx-1" />

          {/* Botão Exportar Destacado */}
          <button
            type="button"
            disabled={videoClips.length === 0}
            onClick={() => setIsExportModalOpen(true)}
            className="px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-purple-900/30 transition-all cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          >
            <Download className="h-3.5 w-3.5" />
            Exportar MP4
          </button>
        </div>
      </div>

      {/* 2. Área Central Dividida: Biblioteca (Esquerda) + Pré-visualização (Centro/Direita) */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <MediaLibrary
          assets={assets}
          onImportVideos={handleImportVideos}
          onImportMusic={handleImportMusic}
          onAddClipToTimeline={handleAddClipToTimeline}
          onRemoveAsset={handleRemoveAsset}
        />

        <VideoPreview
          playheadSecs={playheadSecs}
          totalDurationSecs={totalDurationSecs}
          isPlaying={isPlaying}
          videoClips={videoClips}
          musicTracks={musicTracks}
          framingMode={framingMode}
          onPlayPause={() => setIsPlaying((p) => !p)}
          onSeek={(newSecs) => setPlayheadSecs(Math.max(0, Math.min(totalDurationSecs, newSecs)))}
          onStepFrame={(dir) =>
            setPlayheadSecs((p) =>
              Math.max(0, Math.min(totalDurationSecs, p + dir * (1 / 60)))
            )
          }
        />
      </div>

      {/* 3. Barra de Ferramentas da Timeline */}
      <TimelineToolbar
        canUndo={canUndo}
        canRedo={canRedo}
        hasSelectedClip={!!selectedClipId}
        snapping={snapping}
        zoom={zoom}
        onSplit={handleSplitAtPlayhead}
        onTrimIn={handleTrimIn}
        onTrimOut={handleTrimOut}
        onDelete={handleDeleteSelected}
        onUndo={undo}
        onRedo={redo}
        onToggleSnapping={() => setSnapping((s) => !s)}
        onZoomChange={setZoom}
        onResetZoom={() => setZoom(35)}
      />

      {/* 4. Timeline Visual Multi-Trilha */}
      <div className="h-64 flex flex-col shrink-0">
        <Timeline
          playheadSecs={playheadSecs}
          totalDurationSecs={totalDurationSecs}
          zoom={zoom}
          snapping={snapping}
          videoClips={videoClips}
          musicTracks={musicTracks}
          selectedClipId={selectedClipId}
          selectedTrackType={selectedTrackType}
          onSelectClip={(id, type) => {
            setSelectedClipId(id);
            setSelectedTrackType(type);
          }}
          onSeek={(secs) => setPlayheadSecs(Math.max(0, Math.min(totalDurationSecs, secs)))}
          onUpdateClip={handleUpdateClip}
          onUpdateMusic={handleUpdateMusic}
          onReorderClips={handleReorderClips}
        />
      </div>

      {/* 5. Modal de Exportação */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        defaultOutputPath={suggestedOutputPath}
        totalDurationSecs={totalDurationSecs}
        framingMode={framingMode}
        onFramingChange={setFramingMode}
        isExporting={isExporting}
        exportProgress={exportProgress}
        onStartExport={handleStartExport}
        onCancelExport={handleCancelExport}
      />
    </div>
  );
}
