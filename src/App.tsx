import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Disc,
  Download,
  Film,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Keyboard,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sliders,
  Square,
  Upload,
  Volume2,
  VolumeX,
  Wrench,
} from "lucide-react";
import type {
  ExportConfig,
  ExportProgress,
  RecordedFileInfo,
  RecorderStatus,
  RecordingConfig,
  SystemCapabilities,
  VideoMetadata,
} from "./types";

function formatElapsed(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BITRATE_OPTIONS = [
  { value: 12000, label: "12 Mbps — Leve (Menor arquivo)" },
  { value: 25000, label: "25 Mbps — Equilibrado (Recomendado)" },
  { value: 40000, label: "40 Mbps — Alta Qualidade PvP" },
  { value: 60000, label: "60 Mbps — Máxima Nitidez" },
];

const DURATION_PRESETS = [
  { label: "Contínua (Manual)", value: null },
  { label: "1 minuto", value: 60 },
  { label: "3 minutos", value: 180 },
  { label: "5 minutos", value: 300 },
  { label: "15 minutos", value: 900 },
  { label: "30 minutos", value: 1800 },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<"recorder" | "editor">("recorder");

  // Estado do Gravador
  const [caps, setCaps] = useState<SystemCapabilities | null>(null);
  const [config, setConfig] = useState<RecordingConfig | null>(null);
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [files, setFiles] = useState<RecordedFileInfo[]>([]);
  const [hotkeyInput, setHotkeyInput] = useState("F9");
  const [customWInput, setCustomWInput] = useState("");
  const [customHInput, setCustomHInput] = useState("");
  const [uiNotice, setUiNotice] = useState<{ type: "err" | "ok"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Estado do Editor
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [editorMeta, setEditorMeta] = useState<VideoMetadata | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [previewFraming, setPreviewFraming] = useState<"stretch" | "fit" | "fill_crop">("stretch");
  const [exportResMode, setExportResMode] = useState<string>("1080p");
  const [exportCustomW, setExportCustomW] = useState<string>("1920");
  const [exportCustomH, setExportCustomH] = useState<string>("1080");
  const [exportFps, setExportFps] = useState<number>(60);
  const [exportBitrate, setExportBitrate] = useState<number>(25000);
  const [exportPath, setExportPath] = useState<string>("");
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Player de Vídeo
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const isRecording = status?.state === "recording" || status?.state === "starting";
  const isBusy = status?.state === "starting" || status?.state === "stopping";

  async function refreshAll() {
    setRefreshing(true);
    try {
      const [c, cfg, st, list] = await Promise.all([
        invoke<SystemCapabilities>("get_system_capabilities"),
        invoke<RecordingConfig>("get_config"),
        invoke<RecorderStatus>("get_recorder_status"),
        invoke<RecordedFileInfo[]>("list_recorded_files"),
      ]);
      setCaps(c);
      setConfig(cfg);
      setHotkeyInput(cfg.hotkey);
      setStatus(st);
      setFiles(list);
      if (cfg.customWidth) setCustomWInput(String(cfg.customWidth));
      if (cfg.customHeight) setCustomHInput(String(cfg.customHeight));
    } catch (e) {
      setUiNotice({ type: "err", text: String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refreshAll();
    const unlistenStatus = listen<RecorderStatus>("recorder-status", (ev) => {
      setStatus(ev.payload);
      if (ev.payload.state === "idle" || ev.payload.state === "error") {
        invoke<RecordedFileInfo[]>("list_recorded_files").then(setFiles).catch(() => {});
      }
    });

    const unlistenExport = listen<ExportProgress>("export-progress", (ev) => {
      setExportProgress(ev.payload);
      if (ev.payload.state === "done" || ev.payload.state === "error" || ev.payload.state === "cancelled") {
        setIsExporting(false);
        if (ev.payload.state === "done") {
          invoke<RecordedFileInfo[]>("list_recorded_files").then(setFiles).catch(() => {});
        }
      }
    });

    return () => {
      unlistenStatus.then((u) => u());
      unlistenExport.then((u) => u());
    };
  }, []);

  async function updateConfig(patch: Partial<RecordingConfig>) {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    try {
      const saved = await invoke<RecordingConfig>("save_user_config", { config: next });
      setConfig(saved);
      if (patch.outputDir !== undefined) {
        const list = await invoke<RecordedFileInfo[]>("list_recorded_files");
        setFiles(list);
      }
    } catch (e) {
      setUiNotice({ type: "err", text: String(e) });
    }
  }

  async function handleToggleRecording() {
    setUiNotice(null);
    try {
      await invoke<boolean>("toggle_recording");
      const list = await invoke<RecordedFileInfo[]>("list_recorded_files");
      setFiles(list);
    } catch (e) {
      setUiNotice({ type: "err", text: String(e) });
    }
  }

  async function handlePickFolder() {
    if (!config || isRecording) return;
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: config.outputDir,
      title: "Escolha a pasta para salvar as gravações do RAVIX",
    });
    if (typeof selected === "string" && selected.length > 0) {
      await updateConfig({ outputDir: selected });
    }
  }

  async function handleApplyHotkey() {
    setUiNotice(null);
    try {
      await invoke("update_hotkey", { hotkey: hotkeyInput });
      if (config) setConfig({ ...config, hotkey: hotkeyInput.trim() });
      setUiNotice({ type: "ok", text: `Atalho global '${hotkeyInput.trim()}' atualizado.` });
    } catch (e) {
      setUiNotice({ type: "err", text: String(e) });
    }
  }

  // Carregar vídeo no Editor
  async function loadVideoInEditor(filePath: string) {
    setEditorLoading(true);
    setUiNotice(null);
    setExportProgress(null);
    try {
      const meta = await invoke<VideoMetadata>("get_video_metadata", { path: filePath });
      setEditorFile(filePath);
      setEditorMeta(meta);

      // Sugerir caminho de exportação padrão (não sobrescreve o original)
      const dotIdx = filePath.lastIndexOf(".");
      const baseName = dotIdx !== -1 ? filePath.slice(0, dotIdx) : filePath;
      const defaultExport = `${baseName}_stretched_1080p.mp4`;
      setExportPath(defaultExport);

      if (meta.fps > 0) {
        setExportFps(Math.round(meta.fps));
      }
      setIsPlaying(false);
      setCurrentTime(0);
    } catch (e) {
      setUiNotice({ type: "err", text: `Falha ao carregar metadados do vídeo: ${e}` });
    } finally {
      setEditorLoading(false);
    }
  }

  async function handlePickEditorFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Vídeos", extensions: ["mp4", "mkv", "mov", "webm"] }],
      title: "Selecione o vídeo para abrir no editor do RAVIX",
    });
    if (typeof selected === "string" && selected.length > 0) {
      await loadVideoInEditor(selected);
    }
  }

  async function handlePickExportPath() {
    const selected = await save({
      defaultPath: exportPath || "video_stretched.mp4",
      filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }],
      title: "Salvar vídeo exportado como",
    });
    if (typeof selected === "string" && selected.length > 0) {
      setExportPath(selected);
    }
  }

  async function handleStartExport() {
    if (!editorFile || !exportPath) return;
    setIsExporting(true);
    setExportProgress({
      state: "exporting",
      progressPct: 0,
      elapsedSecs: 0,
      currentFps: 0,
      outputPath: null,
      error: null,
    });
    try {
      const cfg: ExportConfig = {
        inputPath: editorFile,
        outputPath: exportPath,
        resolutionMode: exportResMode,
        customWidth: exportResMode === "custom" ? Number(exportCustomW) || 1920 : null,
        customHeight: exportResMode === "custom" ? Number(exportCustomH) || 1080 : null,
        framingMode: previewFraming,
        fps: exportFps,
        bitrateKbps: exportBitrate,
      };
      await invoke("start_video_export", { config: cfg });
    } catch (e) {
      setIsExporting(false);
      setExportProgress({
        state: "error",
        progressPct: 0,
        elapsedSecs: 0,
        currentFps: 0,
        outputPath: null,
        error: String(e),
      });
    }
  }

  async function handleCancelExport() {
    try {
      await invoke("cancel_video_export");
    } catch (e) {
      console.error(e);
    }
  }

  const selectedSource = useMemo(
    () => caps?.sources.find((s) => s.id === config?.sourceId && s.kind === config?.sourceKind),
    [caps, config]
  );

  // Detecção de resolução da fonte e transformação
  const sourceResolutionText = useMemo(() => {
    if (!selectedSource) return "Detectando...";
    return `${selectedSource.width} × ${selectedSource.height}`;
  }, [selectedSource]);

  const transformAnalysis = useMemo(() => {
    const srcW = selectedSource?.width ?? 1100;
    const srcH = selectedSource?.height ?? 1080;
    const mode = config?.resolutionMode ?? "1080p";
    const framing = config?.framingMode ?? "stretch";

    let targetW = srcW;
    let targetH = srcH;
    if (mode === "1080p") {
      targetW = 1920;
      targetH = 1080;
    } else if (mode === "1440p") {
      targetW = 2560;
      targetH = 1440;
    } else if (mode === "custom") {
      targetW = config?.customWidth || 1920;
      targetH = config?.customHeight || 1080;
    }

    const srcAr = srcW / srcH;
    const targetAr = targetW / targetH;
    const isAlready16x9 = Math.abs(srcAr - targetAr) < 0.02;

    if (isAlready16x9) {
      return {
        isStretched: false,
        text: `Fonte já em proporção ${targetW}x${targetH} — mapeamento direto 1:1 sem distorção repetida.`,
        badgeCls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
      };
    }

    if (framing === "stretch") {
      const stretchPercent = Math.round(((targetW / targetH) / srcAr - 1) * 100);
      const sign = stretchPercent >= 0 ? "+" : "";
      return {
        isStretched: true,
        text: `Esticamento horizontal ativo (${sign}${stretchPercent}% largura) — 0 barras pretas adicionadas (idêntico ao OBS Ctrl+S).`,
        badgeCls: "bg-purple-500/15 text-purple-300 border-purple-500/35",
      };
    } else if (framing === "fit") {
      return {
        isStretched: false,
        text: `Manter proporção ativo — adiciona barras laterais para enquadrar na tela ${targetW}x${targetH}.`,
        badgeCls: "bg-blue-500/15 text-blue-300 border-blue-500/35",
      };
    } else {
      return {
        isStretched: false,
        text: `Preencher e cortar ativo — preenche o quadro ${targetW}x${targetH} cortando bordas excedentes sem distorcer.`,
        badgeCls: "bg-amber-500/15 text-amber-300 border-amber-500/35",
      };
    }
  }, [selectedSource, config?.resolutionMode, config?.framingMode, config?.customWidth, config?.customHeight]);

  if (!config || !caps || !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#090B0E] text-zinc-400">
        Inicializando motor RAVIX V0.2.0...
      </div>
    );
  }

  const stateBadge = (() => {
    switch (status.state) {
      case "recording":
        return { text: "GRAVANDO", cls: "bg-red-500/15 text-red-400 border-red-500/40", dot: "bg-red-500 animate-pulse" };
      case "starting":
        return { text: "INICIANDO", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40", dot: "bg-amber-400 animate-pulse" };
      case "stopping":
        return { text: "FINALIZANDO", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40", dot: "bg-amber-400" };
      case "error":
        return { text: "ERRO", cls: "bg-red-500/20 text-red-300 border-red-500/50", dot: "bg-red-500" };
      default:
        return { text: "PRONTO", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/35", dot: "bg-emerald-400" };
    }
  })();

  return (
    <div className="min-h-screen bg-[#090B0E] text-zinc-100 flex flex-col font-sans select-none">
      {/* Top Bar com Navegação em Abas */}
      <header className="border-b border-zinc-800/80 bg-[#0D1016] px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-purple-500/20 via-emerald-500/10 to-zinc-900 border border-purple-500/40 flex items-center justify-center shadow-lg shadow-purple-950/20">
              <Disc className={`h-5 w-5 ${isRecording ? "text-red-400 animate-spin" : "text-purple-400"}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-wider text-white">RAVIX</span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  V0.2.0
                </span>
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${stateBadge.cls}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${stateBadge.dot}`} />
                  {stateBadge.text}
                </span>
              </div>
            </div>
          </div>

          {/* Seletor de Abas: GRAVADOR / EDITOR */}
          <nav className="flex items-center gap-1 bg-[#121620] p-1 rounded-xl border border-zinc-800">
            <button
              onClick={() => setActiveTab("recorder")}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === "recorder"
                  ? "bg-gradient-to-r from-emerald-500/20 to-purple-500/20 text-white border border-purple-500/40 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Disc className="h-3.5 w-3.5 text-emerald-400" />
              GRAVADOR
            </button>
            <button
              onClick={() => setActiveTab("editor")}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === "editor"
                  ? "bg-gradient-to-r from-purple-500/20 to-emerald-500/20 text-white border border-purple-500/40 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Film className="h-3.5 w-3.5 text-purple-400" />
              EDITOR DE VÍDEO
              {editorMeta && (
                <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />
              )}
            </button>
          </nav>
        </div>

        {/* Timer / Botão de Gravação Rápida */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-xl font-bold tracking-tight text-white">
              {formatElapsed(status.elapsedSecs)}
              {status.durationLimitSecs ? (
                <span className="text-xs font-normal text-zinc-400">
                  {" / "}
                  {formatElapsed(status.durationLimitSecs)}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-zinc-400 flex items-center justify-end gap-1">
              <Keyboard className="h-3 w-3 text-purple-400" />
              Atalho: <span className="text-zinc-200 font-semibold">{config.hotkey}</span>
            </div>
          </div>

          <button
            onClick={handleToggleRecording}
            disabled={isBusy}
            className={`px-4 py-2.5 rounded-xl font-semibold text-xs flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50 ${
              isRecording
                ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-950/50"
                : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-lg shadow-emerald-950/50"
            }`}
          >
            {isRecording ? (
              <>
                <Square className="h-3.5 w-3.5 fill-current" />
                Parar
              </>
            ) : (
              <>
                <Disc className="h-3.5 w-3.5" />
                Gravar
              </>
            )}
          </button>
        </div>
      </header>

      {/* Alertas Globais */}
      {(uiNotice || status.lastError || status.fpsWarning) && (
        <div className="px-6 pt-3 space-y-2">
          {status.fpsWarning && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>{status.fpsWarning}</span>
            </div>
          )}
          {(status.lastError || uiNotice?.type === "err") && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <span>{uiNotice?.type === "err" ? uiNotice.text : status.lastError}</span>
            </div>
          )}
          {uiNotice?.type === "ok" && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{uiNotice.text}</span>
            </div>
          )}
        </div>
      )}

      {/* CONTEÚDO DA ABA SELECIONADA */}
      {activeTab === "recorder" ? (
        /* ======================== ABA GRAVADOR ======================== */
        <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-y-auto">
          {/* Coluna Esquerda: Controles e Resolução Stretched */}
          <div className="lg:col-span-7 space-y-4">
            {/* Banner: Gravador — Em desenvolvimento */}
            <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 px-4 py-3 flex items-center justify-between text-xs text-purple-200">
              <div className="flex items-center gap-2.5">
                <Wrench className="h-4 w-4 text-purple-400 shrink-0" />
                <div>
                  <span className="font-semibold text-white">Gravador — Em desenvolvimento</span>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    Estabilidade básica e gravação esticada validadas. Otimizações de frametime e latência em evolução contínua.
                  </p>
                </div>
              </div>
              <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-purple-950/60 border border-purple-500/30 text-purple-300">
                WGC + D3D11 HW
              </span>
            </div>

            {/* Perfis Rápidos de Gravação */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">Perfil de Gravação</h2>
                </div>
                <span className="text-[11px] text-purple-300 font-medium">Recomendado para FiveM</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() =>
                    updateConfig({
                      resolutionMode: "1080p",
                      framingMode: "stretch",
                      fps: 60,
                      bitrateKbps: 25000,
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer disabled:opacity-50 ${
                    config.resolutionMode === "1080p" && config.framingMode === "stretch"
                      ? "border-purple-500/60 bg-purple-500/15 text-white shadow-sm"
                      : "border-zinc-800 bg-[#090B0E] text-zinc-300 hover:border-zinc-700"
                  }`}
                >
                  <div className="font-semibold text-xs text-purple-300">FiveM PvP — Stretched 1080p</div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    1920x1080 • Esticar para preencher • 60 FPS
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() =>
                    updateConfig({
                      resolutionMode: "native",
                      framingMode: "fit",
                      fps: 60,
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer disabled:opacity-50 ${
                    config.resolutionMode === "native" && config.framingMode === "fit"
                      ? "border-emerald-500/60 bg-emerald-500/15 text-white shadow-sm"
                      : "border-zinc-800 bg-[#090B0E] text-zinc-300 hover:border-zinc-700"
                  }`}
                >
                  <div className="font-semibold text-xs text-emerald-300">Padrão Nativo</div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Resolução Original • Manter proporção
                  </div>
                </button>

                <button
                  type="button"
                  disabled={isRecording}
                  onClick={() =>
                    updateConfig({
                      resolutionMode: "1440p",
                      framingMode: "stretch",
                      fps: 60,
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer disabled:opacity-50 ${
                    config.resolutionMode === "1440p" && config.framingMode === "stretch"
                      ? "border-purple-500/60 bg-purple-500/15 text-white shadow-sm"
                      : "border-zinc-800 bg-[#090B0E] text-zinc-300 hover:border-zinc-700"
                  }`}
                >
                  <div className="font-semibold text-xs text-purple-300">PvP 1440p Quad HD</div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    2560x1440 • Esticar para preencher
                  </div>
                </button>
              </div>
            </section>

            {/* Fonte de Captura e Resolução Detectada */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Monitor className="h-4 w-4 text-emerald-400" />
                  <h2 className="text-sm font-semibold text-white">Fonte & Dimensões Detectadas</h2>
                </div>
                <button
                  onClick={refreshAll}
                  disabled={refreshing || isRecording}
                  className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/70 hover:bg-zinc-800 cursor-pointer disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                  Atualizar Janelas
                </button>
              </div>

              <select
                disabled={isRecording}
                value={`${config.sourceKind}:${config.sourceId}`}
                onChange={(e) => {
                  const idx = e.target.value.indexOf(":");
                  const kind = e.target.value.slice(0, idx);
                  const id = e.target.value.slice(idx + 1);
                  updateConfig({ sourceKind: kind, sourceId: id });
                }}
                className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 focus:border-purple-500 focus:outline-none disabled:opacity-60"
              >
                {caps.sources.map((src) => (
                  <option key={`${src.kind}:${src.id}`} value={`${src.kind}:${src.id}`}>
                    {src.isGamePriority ? "[JOGO DETECTADO] " : src.kind === "monitor" ? "[MONITOR] " : "[JANELA] "}
                    {src.title} — {src.width}x{src.height} ({src.processName})
                  </option>
                ))}
              </select>

              {/* Detecção em Tempo Real da Fonte */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">Resolução Real da Captura (WGC)</div>
                  <div className="text-sm font-bold text-white mt-0.5 font-mono flex items-center gap-1.5">
                    <Gamepad2 className="h-3.5 w-3.5 text-purple-400" />
                    {sourceResolutionText}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                  <div className="text-[11px] text-zinc-400">Resolução do Arquivo MP4</div>
                  <div className="text-sm font-bold text-white mt-0.5 font-mono flex items-center gap-1.5">
                    <Film className="h-3.5 w-3.5 text-emerald-400" />
                    {config.resolutionMode === "1080p"
                      ? "1920 × 1080"
                      : config.resolutionMode === "1440p"
                      ? "2560 × 1440"
                      : config.resolutionMode === "custom"
                      ? `${config.customWidth || 1920} × ${config.customHeight || 1080}`
                      : sourceResolutionText}
                  </div>
                </div>
              </div>

              {/* Status da Transformação Geométrica */}
              <div className={`p-2.5 rounded-lg border text-xs flex items-center gap-2 ${transformAnalysis.badgeCls}`}>
                <ShieldCheck className="h-4 w-4 shrink-0" />
                <span>{transformAnalysis.text}</span>
              </div>
            </section>

            {/* Enquadramento, Resolução Alvo e FPS */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Resolução de Saída & Enquadramento</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Resolução do Vídeo Gravado</label>
                  <select
                    disabled={isRecording}
                    value={config.resolutionMode}
                    onChange={(e) => updateConfig({ resolutionMode: e.target.value })}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                  >
                    <option value="1080p">1920 × 1080 (Full HD — Padrão FiveM)</option>
                    <option value="1440p">2560 × 1440 (Quad HD 2K)</option>
                    <option value="native">Original / Nativa da Fonte</option>
                    <option value="custom">Personalizada...</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Método de Enquadramento</label>
                  <select
                    disabled={isRecording}
                    value={config.framingMode}
                    onChange={(e) => updateConfig({ framingMode: e.target.value })}
                    className="w-full rounded-lg border border-purple-500/50 bg-[#090B0E] px-3 py-2 text-sm text-purple-200 font-medium disabled:opacity-60"
                  >
                    <option value="stretch">Esticar para preencher (OBS Ctrl+S — Sem barras)</option>
                    <option value="fit">Manter proporção (Adiciona barras)</option>
                    <option value="fill_crop">Preencher e cortar (Sem barras, corta bordas)</option>
                  </select>
                </div>

                {config.resolutionMode === "custom" && (
                  <div className="sm:col-span-2 grid grid-cols-2 gap-3 p-3 rounded-lg bg-[#090B0E] border border-zinc-800">
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Largura Personalizada (px)</label>
                      <input
                        type="number"
                        disabled={isRecording}
                        value={customWInput}
                        placeholder="Ex: 1920"
                        onChange={(e) => setCustomWInput(e.target.value)}
                        onBlur={() => {
                          const w = Number(customWInput);
                          if (w >= 320) updateConfig({ customWidth: w });
                        }}
                        className="w-full rounded border border-zinc-700 bg-[#10141B] px-2.5 py-1.5 text-xs text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Altura Personalizada (px)</label>
                      <input
                        type="number"
                        disabled={isRecording}
                        value={customHInput}
                        placeholder="Ex: 1080"
                        onChange={(e) => setCustomHInput(e.target.value)}
                        onBlur={() => {
                          const h = Number(customHInput);
                          if (h >= 240) updateConfig({ customHeight: h });
                        }}
                        className="w-full rounded border border-zinc-700 bg-[#10141B] px-2.5 py-1.5 text-xs text-white"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Taxa de Quadros (FPS)</label>
                  <select
                    disabled={isRecording}
                    value={config.fps}
                    onChange={(e) => updateConfig({ fps: Number(e.target.value) })}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                  >
                    {caps.supportedFps.map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} FPS {fps === 60 ? "(Padrão)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Qualidade / Bitrate</label>
                  <select
                    disabled={isRecording}
                    value={config.bitrateKbps}
                    onChange={(e) => updateConfig({ bitrateKbps: Number(e.target.value) })}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                  >
                    {BITRATE_OPTIONS.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Encoder & Duração */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-2 border-t border-zinc-800/70">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1 font-medium">Encoder H.264</label>
                  <select
                    disabled={isRecording}
                    value={config.encoderId}
                    onChange={(e) => updateConfig({ encoderId: e.target.value })}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-xs text-zinc-100 disabled:opacity-60"
                  >
                    {caps.encoders.map((enc) => (
                      <option key={enc.id} value={enc.id}>
                        {enc.isHardware ? `[HW ${enc.vendor}] ` : "[Software] "}
                        {enc.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1 font-medium">Modo / Duração da Gravação</label>
                  <select
                    disabled={isRecording}
                    value={config.durationLimitSecs === null ? "manual" : String(config.durationLimitSecs)}
                    onChange={(e) => {
                      const val = e.target.value === "manual" ? null : Number(e.target.value);
                      updateConfig({ durationLimitSecs: val });
                    }}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-xs text-zinc-100 disabled:opacity-60"
                  >
                    {DURATION_PRESETS.map((d) => (
                      <option key={d.label} value={d.value === null ? "manual" : String(d.value)}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2 pt-2 border-t border-zinc-800/70">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="block text-xs text-zinc-400 font-medium">Atalho Global (Gravar / Parar)</label>
                      <span className="text-[11px] text-zinc-500">Pressione a tecla para iniciar ou encerrar a captura</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        disabled={isRecording}
                        value={hotkeyInput}
                        onChange={(e) => setHotkeyInput(e.target.value)}
                        placeholder="F9"
                        className="w-24 text-center rounded border border-zinc-700/80 bg-[#090B0E] px-2.5 py-1 text-xs text-zinc-100 font-mono font-bold uppercase disabled:opacity-60"
                      />
                      <button
                        type="button"
                        disabled={isRecording || hotkeyInput.trim() === config.hotkey}
                        onClick={handleApplyHotkey}
                        className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        Salvar
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Áudio WASAPI */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Volume2 className="h-4 w-4 text-emerald-400" />
                  <h2 className="text-sm font-semibold text-white">Áudio (WASAPI 48kHz Estéreo)</h2>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                      {config.systemAudioEnabled ? <Volume2 className="h-3.5 w-3.5 text-emerald-400" /> : <VolumeX className="h-3.5 w-3.5 text-zinc-500" />}
                      Áudio do Jogo / Sistema
                    </span>
                    <input
                      type="checkbox"
                      disabled={isRecording}
                      checked={config.systemAudioEnabled}
                      onChange={(e) => updateConfig({ systemAudioEnabled: e.target.checked })}
                      className="h-4 w-4 accent-emerald-500 cursor-pointer"
                    />
                  </div>
                  <select
                    disabled={isRecording || !config.systemAudioEnabled}
                    value={config.systemAudioDeviceId ?? ""}
                    onChange={(e) => updateConfig({ systemAudioDeviceId: e.target.value || null })}
                    className="w-full rounded border border-zinc-800 bg-[#10141B] px-2.5 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
                  >
                    <option value="">Dispositivo Padrão do Windows</option>
                    {caps.renderDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.isDefault ? "[Padrão] " : ""}
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                      {config.micEnabled ? <Mic className="h-3.5 w-3.5 text-purple-400" /> : <MicOff className="h-3.5 w-3.5 text-zinc-500" />}
                      Microfone
                    </span>
                    <input
                      type="checkbox"
                      disabled={isRecording}
                      checked={config.micEnabled}
                      onChange={(e) => updateConfig({ micEnabled: e.target.checked })}
                      className="h-4 w-4 accent-purple-500 cursor-pointer"
                    />
                  </div>
                  <select
                    disabled={isRecording || !config.micEnabled}
                    value={config.micDeviceId ?? ""}
                    onChange={(e) => updateConfig({ micDeviceId: e.target.value || null })}
                    className="w-full rounded border border-zinc-800 bg-[#10141B] px-2.5 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
                  >
                    <option value="">Microfone Padrão do Windows</option>
                    {caps.captureDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.isDefault ? "[Padrão] " : ""}
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
          </div>

          {/* Coluna Direita: Telemetria + Vídeos Gravados */}
          <div className="lg:col-span-5 space-y-4 flex flex-col">
            {/* Telemetria em Tempo Real */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-emerald-400" />
                  <h2 className="text-sm font-semibold text-white">Telemetria & Estabilidade</h2>
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  fMP4 Resiliente
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-2.5">
                  <div className="text-[11px] text-zinc-400">FPS Efetivo / Alvo</div>
                  <div className="text-base font-bold text-white mt-0.5 font-mono">
                    {status.actualFps.toFixed(1)} <span className="text-xs font-normal text-zinc-500">/ {status.targetFps}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-2.5">
                  <div className="text-[11px] text-zinc-400">Quadros Gravados / Drop</div>
                  <div className="text-base font-bold text-white mt-0.5 font-mono">
                    {status.framesWritten}{" "}
                    <span className={`text-xs ${status.framesDropped > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                      ({status.framesDropped} drop)
                    </span>
                  </div>
                </div>
                <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-2.5">
                  <div className="text-[11px] text-zinc-400">Uso do RAVIX (CPU / RAM)</div>
                  <div className="text-sm font-semibold text-zinc-200 mt-0.5 font-mono">
                    {status.cpuUsagePct.toFixed(1)}% • {status.memoryMb.toFixed(0)} MB
                  </div>
                </div>
                <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-2.5">
                  <div className="text-[11px] text-zinc-400">Espaço Livre em Disco</div>
                  <div className="text-sm font-semibold text-zinc-200 mt-0.5 font-mono flex items-center gap-1">
                    <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                    {status.freeDiskGb.toFixed(2)} GB
                  </div>
                </div>
              </div>

              {status.currentFile && (
                <div className="text-[11px] text-zinc-400 bg-[#090B0E] border border-zinc-800/80 rounded-lg px-3 py-1.5 truncate">
                  <span className="text-zinc-500">Arquivo ativo: </span>
                  <span className="text-zinc-200">{status.currentFile}</span>
                </div>
              )}
            </section>

            {/* Pasta de Destino e Arquivos */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3 flex-1 flex flex-col min-h-[260px]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Film className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">Gravações Concluídas</h2>
                </div>
                <button
                  onClick={() => invoke("open_recordings_folder")}
                  className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 cursor-pointer"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Abrir Pasta
                </button>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={config.outputDir}
                  className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-1.5 text-xs text-zinc-300 truncate"
                />
                <button
                  disabled={isRecording}
                  onClick={handlePickFolder}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer disabled:opacity-40"
                >
                  Alterar
                </button>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[280px]">
                {files.length === 0 ? (
                  <div className="h-32 flex flex-col items-center justify-center text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
                    <Clock className="h-5 w-5 mb-1.5 text-zinc-600" />
                    Nenhuma gravação nesta pasta ainda.
                  </div>
                ) : (
                  files.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center justify-between gap-2.5 rounded-lg border border-zinc-800/80 bg-[#090B0E] px-3 py-2 hover:border-zinc-700 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-200 truncate">{file.filename}</div>
                        <div className="text-[11px] text-zinc-500">
                          {formatBytes(file.sizeBytes)} • {formatDate(file.modifiedTs)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => {
                            setActiveTab("editor");
                            loadVideoInEditor(file.path);
                          }}
                          className="px-2.5 py-1.5 rounded-md bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 text-xs font-medium flex items-center gap-1 cursor-pointer"
                          title="Abrir este vídeo no Editor do RAVIX"
                        >
                          <Sliders className="h-3 w-3" />
                          Editar
                        </button>
                        <button
                          onClick={() => invoke("open_video_file", { path: file.path })}
                          className="px-2.5 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs font-medium flex items-center gap-1 cursor-pointer"
                        >
                          <Play className="h-3 w-3 fill-current" />
                          Abrir
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </main>
      ) : (
        /* ======================== ABA EDITOR ======================== */
        <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-5 overflow-y-auto">
          {/* Coluna Esquerda: Player e Pré-visualização com Enquadramento */}
          <div className="lg:col-span-7 space-y-4 flex flex-col">
            {/* Header / Seletor de Arquivo */}
            <div className="flex items-center justify-between gap-3 bg-[#10141B] p-3 rounded-xl border border-zinc-800/80">
              <div className="flex items-center gap-2 min-w-0">
                <Film className="h-4 w-4 text-purple-400 shrink-0" />
                <span className="text-xs font-medium text-zinc-200 truncate">
                  {editorMeta ? `${editorMeta.filename} (${editorMeta.width}×${editorMeta.height})` : "Nenhum vídeo aberto no editor"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {files.length > 0 && (
                  <button
                    onClick={() => loadVideoInEditor(files[0].path)}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                    title="Carregar a gravação mais recente"
                  >
                    <Clock className="h-3.5 w-3.5 text-emerald-400" />
                    Última Gravação
                  </button>
                )}
                <button
                  onClick={handlePickEditorFile}
                  disabled={editorLoading || isExporting}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-md shadow-purple-950/40"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Importar Vídeo...
                </button>
              </div>
            </div>

            {/* Área do Player de Vídeo ou Dropzone */}
            {!editorFile ? (
              <div
                onClick={handlePickEditorFile}
                className="flex-1 min-h-[360px] rounded-xl border-2 border-dashed border-zinc-800 hover:border-purple-500/50 bg-[#10141B]/50 flex flex-col items-center justify-center p-8 text-center transition-all cursor-pointer group"
              >
                <div className="h-14 w-14 rounded-2xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                  <Film className="h-7 w-7 text-purple-400" />
                </div>
                <div className="text-sm font-semibold text-white mb-1">
                  Importe um vídeo para editar ou esticar
                </div>
                <p className="text-xs text-zinc-400 max-w-sm">
                  Aceita gravações do OBS Studio (1100×1080), ShadowPlay, Adrenalin ou RAVIX. O arquivo original não será modificado.
                </p>
                <button className="mt-4 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white flex items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5" />
                  Escolher Arquivo do PC
                </button>
              </div>
            ) : (
              <div className="space-y-3 flex-1 flex flex-col">
                {/* Canvas de Preview com Enquadramento Ativo */}
                <div className="relative rounded-xl border border-zinc-800 bg-[#06080B] p-2 flex flex-col items-center justify-center overflow-hidden">
                  {/* Container 16:9 que representa o vídeo final exportado */}
                  <div
                    className="relative w-full rounded-lg overflow-hidden bg-black flex items-center justify-center"
                    style={{ aspectRatio: exportResMode === "1440p" || exportResMode === "1080p" ? "16/9" : `${editorMeta?.width || 16}/${editorMeta?.height || 9}` }}
                  >
                    <video
                      ref={videoRef}
                      src={convertFileSrc(editorFile)}
                      className="w-full h-full"
                      style={{
                        objectFit: previewFraming === "stretch" ? "fill" : previewFraming === "fit" ? "contain" : "cover",
                      }}
                      onTimeUpdate={() => {
                        if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
                      }}
                      onLoadedMetadata={() => {
                        if (videoRef.current) setDuration(videoRef.current.duration);
                      }}
                      onEnded={() => setIsPlaying(false)}
                    />

                    {/* Badge sobreposto com modo de enquadramento ativo */}
                    <div className="absolute top-2 left-2 px-2.5 py-1 rounded bg-black/80 backdrop-blur-sm border border-zinc-800 text-[11px] font-mono font-semibold text-purple-300 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
                      PRÉVIA:{" "}
                      {previewFraming === "stretch"
                        ? "ESTICAR PARA PREENCHER (OBS Ctrl+S)"
                        : previewFraming === "fit"
                        ? "MANTER PROPORÇÃO (COM BARRAS)"
                        : "PREENCHER E CORTAR"}
                    </div>
                  </div>

                  {/* Controles do Player */}
                  <div className="w-full mt-2 px-2 py-1.5 flex items-center gap-3">
                    <button
                      onClick={() => {
                        if (!videoRef.current) return;
                        if (isPlaying) {
                          videoRef.current.pause();
                          setIsPlaying(false);
                        } else {
                          videoRef.current.play();
                          setIsPlaying(true);
                        }
                      }}
                      className="h-8 w-8 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 flex items-center justify-center cursor-pointer"
                    >
                      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current ml-0.5" />}
                    </button>

                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.05}
                      value={currentTime}
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        setCurrentTime(t);
                        if (videoRef.current) videoRef.current.currentTime = t;
                      }}
                      className="flex-1 accent-purple-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                    />

                    <span className="font-mono text-xs text-zinc-300 shrink-0">
                      {formatElapsed(currentTime)} / {formatElapsed(duration)}
                    </span>

                    <button
                      onClick={() => {
                        if (!videoRef.current) return;
                        videoRef.current.muted = !isMuted;
                        setIsMuted(!isMuted);
                      }}
                      className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Seletor Rápido de Enquadramento no Player */}
                <div className="p-3 rounded-xl bg-[#10141B] border border-zinc-800/80 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-200">
                    <span>Alternar Enquadramento na Prévia</span>
                    <span className="text-[11px] font-normal text-zinc-400">Tempo real na tela</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setPreviewFraming("stretch")}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        previewFraming === "stretch"
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm"
                          : "bg-[#090B0E] text-zinc-400 hover:text-zinc-200 border border-zinc-800"
                      }`}
                    >
                      Esticar (Ctrl+S)
                    </button>
                    <button
                      onClick={() => setPreviewFraming("fit")}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        previewFraming === "fit"
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm"
                          : "bg-[#090B0E] text-zinc-400 hover:text-zinc-200 border border-zinc-800"
                      }`}
                    >
                      Manter Proporção
                    </button>
                    <button
                      onClick={() => setPreviewFraming("fill_crop")}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        previewFraming === "fill_crop"
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm"
                          : "bg-[#090B0E] text-zinc-400 hover:text-zinc-200 border border-zinc-800"
                      }`}
                    >
                      Preencher e Cortar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Coluna Direita: Metadados Reais e Painel de Exportação */}
          <div className="lg:col-span-5 space-y-4 flex flex-col">
            {/* Metadados Reais Lidos do Arquivo */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">Propriedades do Vídeo Original</h2>
                </div>
                {editorMeta && (
                  <span className="text-[11px] font-mono text-emerald-400">
                    {formatBytes(editorMeta.sizeBytes)}
                  </span>
                )}
              </div>

              {!editorMeta ? (
                <div className="text-xs text-zinc-500 py-3 text-center border border-dashed border-zinc-800 rounded-lg">
                  Importe um vídeo para inspecionar resolução, FPS e codecs.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">Resolução Original</span>
                    <span className="text-sm font-bold text-white mt-0.5 block">
                      {editorMeta.width} × {editorMeta.height}
                    </span>
                    <span className="text-[10px] text-purple-400 mt-0.5 block">
                      Proporção: {(editorMeta.width / editorMeta.height).toFixed(2)}:1
                    </span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">FPS / Duração</span>
                    <span className="text-sm font-bold text-white mt-0.5 block">
                      {editorMeta.fps.toFixed(1)} FPS
                    </span>
                    <span className="text-[10px] text-zinc-400 mt-0.5 block">
                      {formatElapsed(editorMeta.durationSecs)}
                    </span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">Codec de Vídeo</span>
                    <span className="text-xs font-semibold text-zinc-200 mt-0.5 block">
                      {editorMeta.videoCodec}
                    </span>
                  </div>

                  <div className="p-2.5 rounded-lg bg-[#090B0E] border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">Áudio Integrado</span>
                    <span className="text-xs font-semibold text-zinc-200 mt-0.5 block truncate">
                      {editorMeta.audioCodec} ({editorMeta.audioChannels}ch • {editorMeta.audioSampleRate}Hz)
                    </span>
                  </div>
                </div>
              )}
            </section>

            {/* Painel de Configurações de Exportação */}
            <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3.5 flex-1 flex flex-col justify-between">
              <div className="space-y-3.5">
                <div className="flex items-center gap-2">
                  <Download className="h-4 w-4 text-emerald-400" />
                  <h2 className="text-sm font-semibold text-white">Configurar Exportação de Vídeo</h2>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Resolução do Novo Vídeo</label>
                    <select
                      disabled={isExporting || !editorMeta}
                      value={exportResMode}
                      onChange={(e) => setExportResMode(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-xs text-zinc-100 disabled:opacity-50"
                    >
                      <option value="1080p">1920 × 1080 (Full HD — Padrão FiveM / YouTube)</option>
                      <option value="1440p">2560 × 1440 (Quad HD 2K)</option>
                      <option value="original">Original ({editorMeta ? `${editorMeta.width}x${editorMeta.height}` : "Fonte"})</option>
                      <option value="custom">Personalizada...</option>
                    </select>
                    {exportResMode === "custom" && (
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Largura (px)</label>
                          <input
                            type="number"
                            disabled={isExporting}
                            value={exportCustomW}
                            onChange={(e) => setExportCustomW(e.target.value)}
                            className="w-full rounded border border-zinc-700/80 bg-[#090B0E] px-2.5 py-1 text-xs text-zinc-200"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Altura (px)</label>
                          <input
                            type="number"
                            disabled={isExporting}
                            value={exportCustomH}
                            onChange={(e) => setExportCustomH(e.target.value)}
                            className="w-full rounded border border-zinc-700/80 bg-[#090B0E] px-2.5 py-1 text-xs text-zinc-200"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Enquadramento Aplicado</label>
                    <select
                      disabled={isExporting || !editorMeta}
                      value={previewFraming}
                      onChange={(e) => setPreviewFraming(e.target.value as any)}
                      className="w-full rounded-lg border border-purple-500/50 bg-[#090B0E] px-3 py-2 text-xs text-purple-200 font-semibold disabled:opacity-50"
                    >
                      <option value="stretch">Esticar para preencher (OBS Ctrl+S — Sem barras pretas)</option>
                      <option value="fit">Manter proporção (Letterbox / Pillarbox)</option>
                      <option value="fill_crop">Preencher e cortar (Sem distorção, corta bordas)</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">FPS de Exportação</label>
                      <select
                        disabled={isExporting || !editorMeta}
                        value={exportFps}
                        onChange={(e) => setExportFps(Number(e.target.value))}
                        className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-xs text-zinc-100 disabled:opacity-50"
                      >
                        <option value={60}>60 FPS (Recomendado)</option>
                        <option value={30}>30 FPS</option>
                        <option value={120}>120 FPS</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Bitrate de Exportação</label>
                      <select
                        disabled={isExporting || !editorMeta}
                        value={exportBitrate}
                        onChange={(e) => setExportBitrate(Number(e.target.value))}
                        className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-xs text-zinc-100 disabled:opacity-50"
                      >
                        <option value={12000}>12 Mbps (Leve)</option>
                        <option value={25000}>25 Mbps (Recomendado)</option>
                        <option value={40000}>40 Mbps (Alta qualidade)</option>
                        <option value={60000}>60 Mbps (Máximo)</option>
                      </select>
                    </div>
                  </div>

                  {/* Caminho de Saída */}
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Salvar Novo Vídeo Em</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={exportPath}
                        placeholder="Caminho do vídeo exportado..."
                        className="w-full rounded-lg border border-zinc-800 bg-[#090B0E] px-3 py-1.5 text-xs text-zinc-300 truncate"
                      />
                      <button
                        disabled={isExporting || !editorMeta}
                        onClick={handlePickExportPath}
                        className="shrink-0 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer disabled:opacity-50"
                      >
                        Alterar...
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Botão de Exportação & Barra de Progresso Real */}
              <div className="pt-3 border-t border-zinc-800/80 space-y-3">
                {isExporting && exportProgress && (
                  <div className="space-y-1.5 p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-purple-300">
                        Exportando ({exportProgress.currentFps.toFixed(0)} FPS HW)...
                      </span>
                      <span className="font-mono font-bold text-white">
                        {exportProgress.progressPct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-emerald-400 transition-all duration-150"
                        style={{ width: `${exportProgress.progressPct}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span>Tempo decorrido: {formatElapsed(exportProgress.elapsedSecs)}</span>
                      <button
                        onClick={handleCancelExport}
                        className="text-red-400 hover:text-red-300 cursor-pointer"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}

                {exportProgress?.state === "done" && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      <span className="text-emerald-200 font-medium">Exportação concluída com sucesso!</span>
                    </div>
                    {exportProgress.outputPath && (
                      <button
                        onClick={() => invoke("open_video_file", { path: exportProgress.outputPath! })}
                        className="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-semibold text-xs cursor-pointer"
                      >
                        Abrir Vídeo
                      </button>
                    )}
                  </div>
                )}

                <button
                  disabled={!editorMeta || isExporting}
                  onClick={handleStartExport}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-600 to-emerald-600 hover:from-purple-500 hover:to-emerald-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-950/40 cursor-pointer disabled:opacity-50"
                >
                  <Download className="h-4 w-4" />
                  {isExporting ? "Exportando..." : "Exportar Vídeo (H.264 HW)"}
                </button>
              </div>
            </section>
          </div>
        </main>
      )}
    </div>
  );
}
