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

  // Estado da Agulha (Playhead) e Seleção
  const [playheadSecs, setPlayheadSecs] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTrackType, setSelectedTrackType] = useState<"video" | "music" | null>(null);

  // Altura customizável da Timeline (entre 180px e 340px, padrão 240px)
  const [timelineHeight, setTimelineHeight] = useState<number>(240);
  const isResizingTimeline = useRef<boolean>(false);

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

  // Efeito de Reprodução da Timeline (Loop com performance.now)
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

  // Listener para eventos de progresso de exportação com suporte defensivo
  useEffect(() => {
    const unlisten = listen<any>("export-progress", (ev) => {
      const payload = ev.payload;
      if (!payload) return;
      setExportProgress(payload);

      if (
        payload.state === "done" ||
        payload.state === "error" ||
        payload.state === "cancelled"
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

  // Re-calcular posições sequenciais de início de cada clipe de vídeo
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

  // Importar Múltiplos Vídeos via Dialog
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

  // Importar Várias Músicas Simultaneamente (Item 6)
  async function handleImportMusic() {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Áudios e Músicas", extensions: ["mp3", "wav", "aac", "m4a", "ogg", "flac"] },
        ],
      });

      const pathsToImport: string[] = [];
      if (Array.isArray(selected)) {
        pathsToImport.push(...selected);
      } else if (typeof selected === "string" && (selected as string).length > 0) {
        pathsToImport.push(selected);
      }

      if (pathsToImport.length === 0) return;

      const newAssets: MediaAsset[] = [];
      for (const filePath of pathsToImport) {
        try {
          const meta = await invoke<any>("get_media_metadata", { path: filePath });
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
          newAssets.push(newAsset);
        } catch (err) {
          console.warn("Erro lendo metadados de áudio:", filePath, err);
        }
      }

      if (newAssets.length > 0) {
        setAssets((prev) => {
          const existingPaths = new Set(prev.map((a) => a.path));
          const unique = newAssets.filter((a) => !existingPaths.has(a.path));
          return [...prev, ...unique];
        });

        // Adiciona a primeira música à timeline se a trilha de música estiver vazia
        if (musicTracks.length === 0 && newAssets[0]) {
          handleAddClipToTimeline(newAssets[0]);
        }

        setEditorNotice({
          type: "ok",
          text: `${newAssets.length} ${
            newAssets.length === 1 ? "música importada" : "músicas importadas"
          } com sucesso.`,
        });
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

      // Se a timeline de vídeo estiver vazia, adiciona automaticamente o primeiro vídeo
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
      // Posiciona no playhead ou no final da última faixa de música
      const lastMusicEnd = musicTracks.reduce(
        (max, m) => Math.max(max, m.timelineStartSecs + m.durationSecs),
        0
      );
      const startPos = musicTracks.length === 0 ? 0 : Math.max(playheadSecs, lastMusicEnd);

      const newTrack: TimelineAudioTrack = {
        id: `music_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        assetId: asset.id,
        sourcePath: asset.path,
        name: asset.name,
        timelineStartSecs: startPos,
        inPointSecs: 0,
        durationSecs: asset.durationSecs,
        volume: 0.8,
        isMuted: false,
        fadeInSecs: 0.5,
        fadeOutSecs: 1.0,
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

  // 1. DIVIDIR CLIPE NO CURSOR (Split) — Respeitando seleção de Vídeo ou Música (Item 5)
  function handleSplitAtPlayhead() {
    // Se a música estiver selecionada, divide a música
    if (selectedTrackType === "music" && selectedClipId) {
      const trackIndex = musicTracks.findIndex((m) => m.id === selectedClipId);
      if (trackIndex !== -1) {
        const track = musicTracks[trackIndex];
        const trackStart = track.timelineStartSecs;
        const trackEnd = track.timelineStartSecs + track.durationSecs;

        if (playheadSecs > trackStart + 0.1 && playheadSecs < trackEnd - 0.1) {
          const relSecs = playheadSecs - trackStart;
          const splitPoint = track.inPointSecs + relSecs;

          const leftTrack: TimelineAudioTrack = {
            ...track,
            id: `music_${Date.now()}_left`,
            durationSecs: relSecs,
            fadeOutSecs: Math.min(track.fadeOutSecs, relSecs / 2),
          };

          const rightTrack: TimelineAudioTrack = {
            ...track,
            id: `music_${Date.now()}_right`,
            timelineStartSecs: playheadSecs,
            inPointSecs: splitPoint,
            durationSecs: track.durationSecs - relSecs,
            fadeInSecs: Math.min(track.fadeInSecs, (track.durationSecs - relSecs) / 2),
          };

          const nextMusic = [...musicTracks];
          nextMusic.splice(trackIndex, 1, leftTrack, rightTrack);
          pushState({ videoClips, musicTracks: nextMusic });
          setSelectedClipId(rightTrack.id);
          setSelectedTrackType("music");
          setEditorNotice({ type: "ok", text: "Trecho de música dividido em duas partes." });
          return;
        } else {
          setEditorNotice({
            type: "err",
            text: "Posicione a agulha sobre a música selecionada para dividir.",
          });
          return;
        }
      }
    }

    // Caso contrário (ou se clipe de vídeo estiver selecionado), divide clipe de vídeo
    const clipIndex = videoClips.findIndex(
      (c) =>
        playheadSecs > c.timelineStartSecs + 0.1 &&
        playheadSecs < c.timelineStartSecs + c.durationSecs - 0.1
    );

    if (clipIndex === -1) {
      setEditorNotice({
        type: "err",
        text: "Posicione a agulha sobre um clipe válido para dividir.",
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
    setEditorNotice({ type: "ok", text: "Clipe de vídeo dividido em 2 trechos." });
  }

  // 2. CORTAR INÍCIO ATÉ A AGULHA (Trim In) — Respeitando seleção (Item 5)
  function handleTrimIn() {
    if (selectedTrackType === "music" && selectedClipId) {
      const trackIndex = musicTracks.findIndex((m) => m.id === selectedClipId);
      if (trackIndex !== -1) {
        const track = musicTracks[trackIndex];
        const relSecs = playheadSecs - track.timelineStartSecs;
        if (relSecs > 0.1 && relSecs < track.durationSecs - 0.2) {
          const newIn = track.inPointSecs + relSecs;
          const newDur = track.durationSecs - relSecs;
          const updatedTrack: TimelineAudioTrack = {
            ...track,
            timelineStartSecs: playheadSecs,
            inPointSecs: newIn,
            durationSecs: newDur,
          };
          const nextMusic = [...musicTracks];
          nextMusic[trackIndex] = updatedTrack;
          pushState({ videoClips, musicTracks: nextMusic });
          setEditorNotice({ type: "ok", text: "Início da música cortado." });
          return;
        }
      }
    }

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
    setEditorNotice({ type: "ok", text: "Início do vídeo cortado." });
  }

  // 3. CORTAR FIM A PARTIR DA AGULHA (Trim Out) — Respeitando seleção (Item 5)
  function handleTrimOut() {
    if (selectedTrackType === "music" && selectedClipId) {
      const trackIndex = musicTracks.findIndex((m) => m.id === selectedClipId);
      if (trackIndex !== -1) {
        const track = musicTracks[trackIndex];
        const relSecs = playheadSecs - track.timelineStartSecs;
        if (relSecs > 0.2 && relSecs < track.durationSecs) {
          const updatedTrack: TimelineAudioTrack = {
            ...track,
            durationSecs: relSecs,
          };
          const nextMusic = [...musicTracks];
          nextMusic[trackIndex] = updatedTrack;
          pushState({ videoClips, musicTracks: nextMusic });
          setEditorNotice({ type: "ok", text: "Final da música cortado." });
          return;
        }
      }
    }

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
    setEditorNotice({ type: "ok", text: "Final do vídeo cortado." });
  }

  // 4. EXCLUIR ELEMENTO SELECIONADO (Delete)
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

        const allPaths = [
          ...proj.assets.map((a) => a.path),
          ...proj.videoClips.map((c) => c.sourcePath),
          ...proj.musicTracks.map((m) => m.sourcePath),
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
        progressPct: 0,
        elapsedSecs: 0,
        currentFps: 0,
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
        progressPct: 0,
        elapsedSecs: 0,
        currentFps: 0,
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

  // Redimensionamento de altura da Timeline
  const handleSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingTimeline.current = true;
    const startY = e.clientY;
    const initialHeight = timelineHeight;

    const onMove = (ev: MouseEvent) => {
      if (!isResizingTimeline.current) return;
      const deltaY = startY - ev.clientY;
      const nextH = Math.max(180, Math.min(380, initialHeight + deltaY));
      setTimelineHeight(nextH);
    };

    const onUp = () => {
      isResizingTimeline.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#07090D] overflow-hidden select-none">
      {/* 1. Barra Superior de Projetos & Ações */}
      <div className="h-12 px-6 bg-[#0B0E14] border-b border-zinc-800 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="text-sm font-bold text-white bg-transparent hover:bg-zinc-800/60 focus:bg-zinc-900 border border-transparent focus:border-purple-500/50 rounded-lg px-2 py-1 outline-none transition-all truncate max-w-[240px]"
            title="Clique para renomear o projeto"
          />
          <span className="text-[11px] text-zinc-500 font-mono shrink-0">
            {videoClips.length} {videoClips.length === 1 ? "vídeo" : "vídeos"} |{" "}
            {musicTracks.length} {musicTracks.length === 1 ? "música" : "músicas"} (
            {totalDurationSecs.toFixed(1)}s)
          </span>
        </div>

        {/* Notificação Rápida */}
        {editorNotice && (
          <div
            className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all truncate max-w-sm ${
              editorNotice.type === "ok"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/15 text-red-300 border border-red-500/30"
            }`}
          >
            {editorNotice.type === "ok" ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
            )}
            <span className="truncate">{editorNotice.text}</span>
          </div>
        )}

        {/* Botões do Projeto */}
        <div className="flex items-center gap-2 shrink-0">
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

      {/* 2. Área Central Dividida: Biblioteca (Esquerda) + Prévia Estável (Centro) */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
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

      {/* Divisor Redimensionável sutil entre Área Central e Timeline */}
      <div
        onMouseDown={handleSplitterMouseDown}
        className="h-1.5 bg-zinc-900 hover:bg-purple-500/50 cursor-row-resize transition-colors flex items-center justify-center shrink-0"
        title="Arrastar para redimensionar a altura da timeline"
      >
        <div className="w-8 h-0.5 bg-zinc-700 rounded-full" />
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

      {/* 4. Timeline Visual Multi-Trilha com Altura Controlada */}
      <div style={{ height: `${timelineHeight}px` }} className="flex flex-col shrink-0 min-h-[180px]">
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
