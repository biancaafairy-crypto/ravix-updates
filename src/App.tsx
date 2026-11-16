import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
  Info,
  Keyboard,
  Mic,
  MicOff,
  Monitor,
  Play,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  ExportProgress,
  RecordedFileInfo,
  RecorderStatus,
  RecordingConfig,
  SystemCapabilities,
} from "./types";
import { VideoEditorView } from "./editor/VideoEditorView";
import { StreamView } from "./streaming/StreamView";
import { ErrorBoundary } from "./components/ErrorBoundary";

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
  const [activeTab, setActiveTab] = useState<"recorder" | "editor" | "stream">("recorder");

  // Estado do Gravador
  const [caps, setCaps] = useState<SystemCapabilities | null>(null);
  const [config, setConfig] = useState<RecordingConfig | null>(null);
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [files, setFiles] = useState<RecordedFileInfo[]>([]);
  const [customWInput, setCustomWInput] = useState("");
  const [customHInput, setCustomHInput] = useState("");
  const [uiNotice, setUiNotice] = useState<{ type: "err" | "ok"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Estado do Editor
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const isRecording = status?.state === "recording" || status?.state === "starting";
  const isBusy = status?.state === "starting" || status?.state === "stopping";

  // Estado das Configurações e Atualizador
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"geral" | "atalhos" | "gravacoes" | "captura" | "atualizacoes" | "sobre">("geral");
  const [recordingTarget, setRecordingTarget] = useState<"main" | "replay" | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error"
  >("idle");
  const [updateObj, setUpdateObj] = useState<Update | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number; percent: number } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // Auto-dismiss de avisos de sucesso após 4s (ETAPA 7)
  useEffect(() => {
    if (uiNotice?.type === "ok") {
      const timer = setTimeout(() => {
        setUiNotice(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [uiNotice]);

  // Gravador de Atalhos Interativo com Validação (ETAPA 6)
  useEffect(() => {
    if (!recordingTarget) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecordingTarget(null);
        invoke("resume_hotkey").catch(() => {});
        setUiNotice({ type: "ok", text: "Alteração de atalho cancelada." });
        return;
      }

      if (["Control", "Shift", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) {
        return;
      }

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");

      let mainKey = "";
      if (e.code.startsWith("F") && !isNaN(Number(e.code.substring(1)))) {
        const num = Number(e.code.substring(1));
        if (num >= 1 && num <= 12) {
          mainKey = `F${num}`;
        }
      }

      if (!mainKey) {
        if (e.key.length === 1) {
          mainKey = e.key.toUpperCase();
        } else if (e.code.startsWith("Key")) {
          mainKey = e.code.substring(3).toUpperCase();
        } else if (e.code.startsWith("Digit")) {
          mainKey = e.code.substring(5);
        }
      }

      if (!mainKey) return;

      // Validação: Letras e números isolados sem modificadores não são permitidos
      if (parts.length === 0 && !mainKey.startsWith("F")) {
        setUiNotice({
          type: "err",
          text: "Letras e números isolados não são permitidos como atalho global. Use F1-F12 ou combine com Ctrl, Alt ou Shift.",
        });
        return;
      }

      const combo = parts.length > 0 ? `${parts.join("+")}+${mainKey}` : mainKey;

      if (recordingTarget === "main") {
        invoke("update_hotkey", { hotkey: combo })
          .then(() => {
            if (config) setConfig({ ...config, hotkey: combo });
            setRecordingTarget(null);
            setUiNotice({ type: "ok", text: `Atalho global atualizado para '${combo}'.` });
          })
          .catch((err) => {
            setUiNotice({ type: "err", text: String(err) });
          });
      } else if (recordingTarget === "replay") {
        updateConfig({ replayHotkey: combo });
        setRecordingTarget(null);
        invoke("resume_hotkey").catch(() => {});
        setUiNotice({ type: "ok", text: `Atalho de replay atualizado para '${combo}'.` });
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [recordingTarget, config]);

  useEffect(() => {
    getVersion()
      .then((ver) => {
        setAppVersion(ver);
      })
      .catch(async (err) => {
        console.warn("Falha ao obter versão via getVersion(), tentando comando get_app_version:", err);
        try {
          const ver = await invoke<string>("get_app_version");
          setAppVersion(ver);
        } catch (e2) {
          console.error("Falha ao obter versão do aplicativo:", e2);
        }
      });
  }, []);

  const hasHotkeyConflict =
    (config?.hotkey || "").trim().toUpperCase() ===
    (config?.replayHotkey || "").trim().toUpperCase();

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
      if (ev.payload.state === "exporting") {
        setIsExporting(true);
      } else if (ev.payload.state === "done" || ev.payload.state === "error" || ev.payload.state === "cancelled") {
        setIsExporting(false);
        if (ev.payload.state === "done") {
          invoke<RecordedFileInfo[]>("list_recorded_files").then(setFiles).catch(() => {});
        }
      }
    });

    // Checagem assíncrona discreta de atualizações ao iniciar o aplicativo
    const timer = setTimeout(() => {
      checkForUpdates(false);
    }, 2000);

    return () => {
      clearTimeout(timer);
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

  async function handlePickReplayFolder() {
    if (!config || isRecording) return;
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: config.replayFolder || config.outputDir,
      title: "Escolha a pasta para salvar os replays do RAVIX",
    });
    if (typeof selected === "string" && selected.length > 0) {
      await updateConfig({ replayFolder: selected });
    }
  }

  // Verificação e Instalação de Atualizações
  async function checkForUpdates(manual: boolean = false) {
    if (updateStatus === "checking" || updateStatus === "downloading") return;
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const update = await check();
      if (update) {
        setUpdateObj(update);
        setUpdateStatus("available");
        if (!manual) {
          setUiNotice({
            type: "ok",
            text: `Nova versão do RAVIX disponível (V${update.version})! Abra a engrenagem de configurações para atualizar.`,
          });
        }
      } else {
        setUpdateObj(null);
        setUpdateStatus("up-to-date");
      }
    } catch (err) {
      console.warn("Verificação de atualizações:", err);
      setUpdateError(String(err));
      setUpdateStatus("error");
    }
  }

  async function handleInstallUpdate() {
    if (!updateObj) return;
    if (isRecording || isBusy) {
      setUiNotice({
        type: "err",
        text: "Uma gravação está em andamento. Pare a gravação antes de instalar a atualização.",
      });
      return;
    }
    if (isExporting) {
      setUiNotice({
        type: "err",
        text: "Uma exportação de vídeo está em andamento. Aguarde a finalização antes de atualizar.",
      });
      return;
    }

    try {
      setUpdateStatus("downloading");
      let totalBytes = 0;
      let downloadedBytes = 0;

      await updateObj.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength || 0;
          setUpdateProgress({ downloaded: 0, total: totalBytes, percent: 0 });
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          setUpdateProgress({ downloaded: downloadedBytes, total: totalBytes, percent: pct });
        } else if (event.event === "Finished") {
          setUpdateStatus("downloaded");
        }
      });

      setUpdateStatus("downloaded");
      // Reiniciar o aplicativo de forma autônoma após 1.5s para concluir a instalação
      setTimeout(async () => {
        try {
          await relaunch();
        } catch (relaunchErr) {
          console.error("Falha ao reiniciar automaticamente:", relaunchErr);
        }
      }, 1500);
    } catch (err) {
      console.error("Falha ao instalar atualização:", err);
      setUpdateError(String(err));
      setUpdateStatus("error");
    }
  }

  const selectedSource = useMemo(() => {
    if (!caps || !config) return null;
    let found = caps.sources.find((s) => s.id === config.sourceId && s.kind === config.sourceKind);
    if (!found && config.sourceKind === "monitor") {
      found = caps.sources.find(
        (s) => s.kind === "monitor" && (s.processName === config.sourceId || s.title.includes(config.sourceId))
      );
      if (!found) {
        found = caps.sources.find((s) => s.kind === "monitor");
      }
    }
    if (!found && config.sourceKind === "window") {
      found = caps.sources.find((s) => s.kind === "window" && s.processName === config.sourceId);
    }
    return found || null;
  }, [caps, config]);

  useEffect(() => {
    if (
      selectedSource &&
      config &&
      (config.sourceId !== selectedSource.id || config.sourceKind !== selectedSource.kind)
    ) {
      updateConfig({ sourceKind: selectedSource.kind, sourceId: selectedSource.id });
    }
  }, [selectedSource, config?.sourceId, config?.sourceKind]);

  // Detecção de resolução da fonte e previsão do arquivo final
  const sourceResolutionText = useMemo(() => {
    if (!selectedSource) return "Selecione uma fonte";
    return `${selectedSource.width} × ${selectedSource.height}`;
  }, [selectedSource]);

  const predictedMp4ResolutionText = useMemo(() => {
    if (!config) return "---";
    if (config.resolutionMode === "1080p") return "1920 × 1080";
    if (config.resolutionMode === "1440p") return "2560 × 1440";
    if (config.resolutionMode === "custom") {
      return `${config.customWidth || 1920} × ${config.customHeight || 1080}`;
    }
    if (selectedSource) {
      return `${selectedSource.width} × ${selectedSource.height}`;
    }
    return "Nativa da fonte";
  }, [config?.resolutionMode, config?.customWidth, config?.customHeight, selectedSource]);

  const transformAnalysis = useMemo(() => {
    if (!selectedSource) {
      return {
        isStretched: false,
        text: "Selecione um monitor ou janela para calcular o enquadramento.",
        badgeCls: "bg-zinc-800/80 text-zinc-400 border-zinc-700/80",
      };
    }

    const srcW = selectedSource.width;
    const srcH = selectedSource.height;
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

    // 1. Mapeamento 1:1 nativo real (sem alteração dimensional)
    if (srcW === targetW && srcH === targetH) {
      return {
        isStretched: false,
        text: `Mapeamento nativo 1:1 (${srcW}×${srcH}) — captura direta sem redimensionamento.`,
        badgeCls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
      };
    }

    const srcAr = srcW / srcH;
    const targetAr = targetW / targetH;
    const isSameAspectRatio = Math.abs(srcAr - targetAr) < 0.02;

    // 2. Proporção idêntica com escala (ex: 2560x1440 -> 1920x1080)
    if (isSameAspectRatio) {
      const scaleType = targetW < srcW ? "Redução proporcional (downscale)" : "Upscale proporcional";
      return {
        isStretched: false,
        text: `${scaleType} 16:9 (${srcW}×${srcH} → ${targetW}×${targetH}) sem distorção geométrica.`,
        badgeCls: "bg-blue-500/10 text-blue-300 border-blue-500/30",
      };
    }

    // 3. Proporções diferentes (ex: FiveM 4:3 ou 16:10 para 16:9)
    if (framing === "stretch") {
      const stretchPercent = Math.round(((targetW / targetH) / srcAr - 1) * 100);
      const sign = stretchPercent >= 0 ? "+" : "";
      return {
        isStretched: true,
        text: `Esticamento horizontal ativo (${sign}${stretchPercent}% largura) — converte ${srcW}×${srcH} em ${targetW}×${targetH} sem barras pretas.`,
        badgeCls: "bg-purple-500/15 text-purple-300 border-purple-500/35",
      };
    } else if (framing === "fit") {
      return {
        isStretched: false,
        text: `Manter proporção ativo — preserva ${srcW}×${srcH} com barras laterais (pillarbox) em ${targetW}×${targetH}.`,
        badgeCls: "bg-zinc-800 text-zinc-300 border-zinc-700",
      };
    } else {
      return {
        isStretched: false,
        text: `Preenchimento com corte (Fill Crop) — preenche ${targetW}×${targetH} cortando bordas excedentes.`,
        badgeCls: "bg-amber-500/15 text-amber-300 border-amber-500/35",
      };
    }
  }, [selectedSource, config?.resolutionMode, config?.framingMode, config?.customWidth, config?.customHeight]);

  if (!config || !caps || !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#090B0E] text-zinc-400">
        Inicializando motor RAVIX{appVersion ? ` V${appVersion}` : ""}...
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
        return null;
    }
  })();

  return (
    <div className="h-screen bg-[#090B0E] text-zinc-100 flex flex-col font-sans select-none overflow-hidden">
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
                  {appVersion ? `V${appVersion}` : "..."}
                </span>
                {stateBadge && (
                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${stateBadge.cls}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${stateBadge.dot}`} />
                    {stateBadge.text}
                  </span>
                )}
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
              {editorFile && (
                <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />
              )}
            </button>
            <button
              onClick={() => setActiveTab("stream")}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                activeTab === "stream"
                  ? "bg-gradient-to-r from-rose-500/20 to-purple-500/20 text-white border border-rose-500/40 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Radio className="h-3.5 w-3.5 text-rose-400" />
              TRANSMISSÃO
            </button>
            {isRecording && activeTab !== "recorder" && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/15 border border-red-500/30 text-[11px] text-red-300 animate-pulse">
                <span className="h-2 w-2 rounded-full bg-red-500" />
                <span>Gravando ({formatElapsed(status.elapsedSecs)})</span>
              </div>
            )}
          </nav>
        </div>

        {/* Timer / Botão de Gravação Rápida / Configurações */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono text-xl font-bold tracking-tight text-white">
              {formatElapsed(isRecording ? status.elapsedSecs : 0)}
              {isRecording && status.durationLimitSecs ? (
                <span className="text-xs font-normal text-zinc-400">
                  {" / "}
                  {formatElapsed(status.durationLimitSecs)}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-zinc-400 flex items-center justify-end gap-1.5">
              <Keyboard className="h-3 w-3 text-purple-400" />
              <span>Atalho:</span>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("atalhos");
                  setShowSettings(true);
                }}
                className="font-semibold px-2 py-0.5 rounded text-xs bg-zinc-800 hover:bg-zinc-700 text-purple-300 border border-zinc-700/80 hover:border-purple-500/50 transition-all cursor-pointer font-mono"
                title="Clique para configurar atalhos no menu de Configurações"
              >
                {config.hotkey || "F9"}
              </button>
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

          {/* Engrenagem de Configurações Geral do Aplicativo */}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="relative p-2.5 rounded-xl border border-zinc-800 bg-[#121620] hover:bg-[#181d2a] text-zinc-400 hover:text-white transition-all cursor-pointer"
            title="Configurações do RAVIX"
          >
            <Settings className="h-4 w-4" />
            {updateStatus === "available" && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-purple-500 ring-2 ring-[#0D1016] animate-pulse" />
            )}
          </button>
        </div>
      </header>

      {/* Alertas do Gravador (apenas visíveis na aba Gravador e enquanto relevantes) */}
      {activeTab === "recorder" && (uiNotice || (isRecording && status.fpsWarning) || status.lastError) && (
        <div className="px-6 pt-3 space-y-2">
          {isRecording && status.fpsWarning && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                <span>{status.fpsWarning}</span>
              </div>
            </div>
          )}
          {(status.lastError || uiNotice?.type === "err") && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                <span>{uiNotice?.type === "err" ? uiNotice.text : status.lastError}</span>
              </div>
              <button
                type="button"
                onClick={() => setUiNotice(null)}
                className="p-1 hover:text-white rounded cursor-pointer text-red-300"
                title="Fechar aviso"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {uiNotice?.type === "ok" && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{uiNotice.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setUiNotice(null)}
                className="p-1 hover:text-white rounded cursor-pointer text-emerald-300"
                title="Fechar aviso"
              >
                <X className="h-3.5 w-3.5" />
              </button>
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
            {/* Identificação Discreta: Gravador — Beta */}
            <div className="flex items-center justify-between rounded-xl border border-purple-500/30 bg-purple-950/20 px-3.5 py-2.5">
              <div className="flex items-center gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  Gravador — Beta
                </span>
                <span className="text-xs text-zinc-300">
                  O gravador já pode ser utilizado e continua recebendo melhorias de estabilidade e desempenho.
                </span>
              </div>
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
                  <div className="font-semibold text-xs text-purple-300">PvP Esticado Full HD</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5 font-mono">1920 × 1080 · 60 FPS</div>
                  <p className="text-[11px] text-zinc-400 mt-1.5 leading-snug">
                    Estica a imagem para preencher o vídeo, sem adicionar barras.
                  </p>
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
                  <div className="text-[11px] text-zinc-400 mt-0.5 font-mono">Resolução original</div>
                  <p className="text-[11px] text-zinc-400 mt-1.5 leading-snug">
                    Mantém o formato original da imagem, sem distorcer.
                  </p>
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
                  <div className="font-semibold text-xs text-purple-300">PvP Esticado Quad HD</div>
                  <div className="text-[11px] text-zinc-400 mt-0.5 font-mono">2560 × 1440</div>
                  <p className="text-[11px] text-zinc-400 mt-1.5 leading-snug">
                    Preenche o vídeo em 1440p. Pode exigir mais do PC.
                  </p>
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
                    {predictedMp4ResolutionText}
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
                    <option value="stretch">Esticar para preencher</option>
                    <option value="fit">Manter proporção</option>
                    <option value="fill_crop">Preencher e cortar</option>
                  </select>
                  <p className="text-[11px] text-zinc-400 mt-1.5 leading-snug">
                    {config.framingMode === "stretch" && "Esticar para preencher: Ocupa todo o vídeo sem cortar, mas pode alterar as proporções da imagem."}
                    {config.framingMode === "fit" && "Manter proporção: Mantém o formato da imagem. Podem aparecer barras nas laterais ou acima e abaixo."}
                    {config.framingMode === "fill_crop" && "Preencher e cortar: Ocupa todo o vídeo sem distorcer, mas pode cortar partes das bordas."}
                  </p>
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
                      <label className="block text-xs text-zinc-300 font-medium">Atalho de Gravação</label>
                      <span className="text-[11px] text-zinc-500">Inicia ou encerra a captura instantânea de gameplay</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-3 py-1 rounded bg-[#090B0E] border border-zinc-700/80 text-xs font-mono font-bold text-purple-300">
                        {config.hotkey || "F9"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSettingsTab("atalhos");
                          setShowSettings(true);
                        }}
                        className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
                        title="Alterar atalho no menu de Configurações"
                      >
                        Alterar
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
                            setEditorFile(file.path);
                            setActiveTab("editor");
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
      ) : activeTab === "editor" ? (
        /* ======================== ABA EDITOR (V0.3.1) ======================== */
        <ErrorBoundary fallbackTitle="Editor de Vídeo RAVIX">
          <VideoEditorView
            initialVideoPath={editorFile}
            onClearInitialVideo={() => setEditorFile(null)}
          />
        </ErrorBoundary>
      ) : (
        /* ======================== ABA TRANSMISSÃO (MVP) ======================== */
        <ErrorBoundary fallbackTitle="Transmissão RAVIX">
          <StreamView />
        </ErrorBoundary>
      )}

{/* ======================== MODAL DE CONFIGURAÇÕES GERAIS ======================== */}
      {showSettings && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0E1218] border border-purple-500/40 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-[#121620]">
              <div className="flex items-center gap-2.5">
                <Settings className="h-5 w-5 text-purple-400" />
                <h2 className="text-base font-bold text-white">Configurações do RAVIX</h2>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  {appVersion ? `V${appVersion}` : "..."}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body: Tabs & Content */}
            <div className="flex flex-1 overflow-hidden">
              {/* Sidebar Tabs */}
              <div className="w-48 bg-[#0B0D12] border-r border-zinc-800/80 p-3 space-y-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setSettingsTab("geral")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "geral"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <Sliders className="h-3.5 w-3.5" />
                  Geral
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("atalhos")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "atalhos"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <Keyboard className="h-3.5 w-3.5" />
                  Atalhos
                  {hasHotkeyConflict && <span className="h-2 w-2 rounded-full bg-red-500 ml-auto" />}
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("gravacoes")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "gravacoes"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Gravações & Buffer
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("captura")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "captura"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  Captura
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("atualizacoes")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "atualizacoes"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Atualizações
                  {updateStatus === "available" && <span className="h-2 w-2 rounded-full bg-purple-400 ml-auto animate-pulse" />}
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsTab("sobre")}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                    settingsTab === "sobre"
                      ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40"
                  }`}
                >
                  <Info className="h-3.5 w-3.5" />
                  Sobre
                </button>
              </div>

              {/* Tab Content */}
              <div className="flex-1 p-5 overflow-y-auto space-y-4">
                {/* Aba Geral */}
                {settingsTab === "geral" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Comportamento Geral</h3>
                      <p className="text-xs text-zinc-400">Preferências de inicialização e funcionamento em segundo plano.</p>
                    </div>

                    <div className="space-y-3">
                      <label className="flex items-start gap-3 p-3 rounded-xl bg-[#121620] border border-zinc-800 cursor-pointer hover:border-zinc-700 transition-colors">
                        <input
                          type="checkbox"
                          checked={config.autoStartWithWindows ?? false}
                          onChange={(e) => updateConfig({ autoStartWithWindows: e.target.checked })}
                          className="mt-0.5 h-4 w-4 accent-purple-500 rounded cursor-pointer"
                        />
                        <div>
                          <div className="text-xs font-semibold text-white">Iniciar o RAVIX com o Windows</div>
                          <div className="text-[11px] text-zinc-400">O RAVIX iniciará minimizado na bandeja ao ligar o computador.</div>
                        </div>
                      </label>

                      <label className="flex items-start gap-3 p-3 rounded-xl bg-[#121620] border border-zinc-800 cursor-pointer hover:border-zinc-700 transition-colors">
                        <input
                          type="checkbox"
                          checked={config.minimizeToTrayOnClose}
                          onChange={(e) => updateConfig({ minimizeToTrayOnClose: e.target.checked })}
                          className="mt-0.5 h-4 w-4 accent-purple-500 rounded cursor-pointer"
                        />
                        <div>
                          <div className="text-xs font-semibold text-white">Minimizar para a bandeja ao fechar a janela</div>
                          <div className="text-[11px] text-zinc-400">Mantém o gravador pronto em segundo plano sem interromper partidas.</div>
                        </div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Aba Atalhos */}
                {settingsTab === "atalhos" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Atalhos de Teclado</h3>
                      <p className="text-xs text-zinc-400">Configure as teclas de ação rápida durante o jogo.</p>
                    </div>

                    {hasHotkeyConflict && (
                      <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                        <span>Atenção: Os atalhos de gravação e replay não podem utilizar a mesma tecla.</span>
                      </div>
                    )}

                    <div className="space-y-3">
                      <div className="p-3 rounded-xl bg-[#121620] border border-zinc-800 flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-white">Gravar / Parar Gravação Manual</div>
                          <div className="text-[11px] text-zinc-400">Inicia ou interrompe a captura do jogo.</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (recordingTarget === "main") {
                                setRecordingTarget(null);
                                invoke("resume_hotkey").catch(() => {});
                              } else {
                                setRecordingTarget("main");
                                invoke("suspend_hotkey").catch(() => {});
                              }
                            }}
                            className={`min-w-[150px] text-center font-mono font-bold text-xs px-3 py-2 rounded-lg border transition-all cursor-pointer ${
                              recordingTarget === "main"
                                ? "bg-purple-600 border-purple-400 text-white animate-pulse ring-2 ring-purple-400/50 shadow-lg"
                                : "bg-[#090B0E] border-zinc-700 text-white hover:border-purple-500"
                            }`}
                          >
                            {recordingTarget === "main"
                              ? "Pressione a tecla..."
                              : config.hotkey || "F9"}
                          </button>
                          {recordingTarget === "main" && (
                            <button
                              type="button"
                              onClick={() => {
                                setRecordingTarget(null);
                                invoke("resume_hotkey").catch(() => {});
                              }}
                              className="px-2.5 py-1.5 text-[11px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold cursor-pointer"
                            >
                              Cancelar
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#121620] border border-zinc-800 flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-white">Salvar Buffer de Repetição (Replay)</div>
                          <div className="text-[11px] text-zinc-400">Salva os últimos segundos do replay configurado.</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (recordingTarget === "replay") {
                                setRecordingTarget(null);
                                invoke("resume_hotkey").catch(() => {});
                              } else {
                                setRecordingTarget("replay");
                                invoke("suspend_hotkey").catch(() => {});
                              }
                            }}
                            className={`min-w-[150px] text-center font-mono font-bold text-xs px-3 py-2 rounded-lg border transition-all cursor-pointer ${
                              recordingTarget === "replay"
                                ? "bg-purple-600 border-purple-400 text-white animate-pulse ring-2 ring-purple-400/50 shadow-lg"
                                : "bg-[#090B0E] border-zinc-700 text-white hover:border-purple-500"
                            }`}
                          >
                            {recordingTarget === "replay"
                              ? "Pressione a tecla..."
                              : config.replayHotkey || "F8"}
                          </button>
                          {recordingTarget === "replay" && (
                            <button
                              type="button"
                              onClick={() => {
                                setRecordingTarget(null);
                                invoke("resume_hotkey").catch(() => {});
                              }}
                              className="px-2.5 py-1.5 text-[11px] rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold cursor-pointer"
                            >
                              Cancelar
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Aba Gravações & Buffer */}
                {settingsTab === "gravacoes" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Armazenamento & Replays</h3>
                      <p className="text-xs text-zinc-400">Diretórios onde os vídeos gravados e replays são salvos.</p>
                    </div>

                    <div className="space-y-3">
                      <div className="p-3 rounded-xl bg-[#121620] border border-zinc-800 space-y-2">
                        <label className="block text-xs font-semibold text-white">Pasta Principal de Gravações</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            readOnly
                            value={config.outputDir}
                            className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-[#090B0E] border border-zinc-800 text-zinc-300 font-mono"
                          />
                          <button
                            type="button"
                            onClick={handlePickFolder}
                            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white transition-colors cursor-pointer"
                          >
                            Alterar
                          </button>
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#121620] border border-zinc-800 space-y-2">
                        <label className="block text-xs font-semibold text-white">Pasta de Replays (Buffer de Repetição)</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            readOnly
                            value={config.replayFolder || `${config.outputDir}\\Replays`}
                            className="flex-1 text-xs px-3 py-1.5 rounded-lg bg-[#090B0E] border border-zinc-800 text-zinc-300 font-mono"
                          />
                          <button
                            type="button"
                            onClick={handlePickReplayFolder}
                            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white transition-colors cursor-pointer"
                          >
                            Alterar
                          </button>
                        </div>
                      </div>

                      <div className="p-3 rounded-xl bg-[#121620] border border-zinc-800 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="block text-xs font-semibold text-white">Duração do Buffer de Repetição</label>
                          <span className="text-[10px] text-purple-300 font-mono">Retenção de memória</span>
                        </div>
                        <select
                          value={config.replayDurationSecs ?? 30}
                          onChange={(e) => updateConfig({ replayDurationSecs: Number(e.target.value) })}
                          className="w-full text-xs px-3 py-2 rounded-lg bg-[#090B0E] border border-zinc-700 text-zinc-200"
                        >
                          <option value={15}>15 segundos (Instantâneo — Menor consumo)</option>
                          <option value={30}>30 segundos (Padrão para lances PvP)</option>
                          <option value={60}>1 minuto</option>
                          <option value={120}>2 minutos</option>
                          <option value={300}>5 minutos (Maior uso de recursos)</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* Aba Captura */}
                {settingsTab === "captura" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Preferências de Captura</h3>
                      <p className="text-xs text-zinc-400">Recursos do sistema operacional e compatibilidade gráfica.</p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-[#121620] border border-zinc-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-zinc-300">Borda Amarela de Privacidade do Windows</span>
                        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                          Recurso Nativo WGC
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        A borda amarela é um recurso de segurança e privacidade nativo do Windows (Windows Graphics Capture - WGC), exibida pelo sistema operacional para indicar visualmente que uma janela ou monitor está sendo capturado por um aplicativo. O RAVIX já suporta a remoção nativa da borda amarela em sistemas Windows 11 atualizados (Build 22000 ou superior), onde a Microsoft disponibilizou a API oficial de desativação (IsBorderRequired = false).
                      </p>
                    </div>
                  </div>
                )}

                {/* Aba Atualizações */}
                {settingsTab === "atualizacoes" && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-1">Atualizações do RAVIX</h3>
                        <p className="text-xs text-zinc-400">Instalação direta de novas versões sem abrir navegador.</p>
                      </div>
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                        Canal Beta
                      </span>
                    </div>

                    <div className="p-4 rounded-xl bg-[#121620] border border-zinc-800 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-semibold text-white">Versão Instalada</div>
                          <div className="text-[11px] text-zinc-400">RAVIX Desktop v{appVersion || "..."} (x64 Windows)</div>
                        </div>
                        <button
                          type="button"
                          disabled={updateStatus === "checking" || updateStatus === "downloading"}
                          onClick={() => checkForUpdates(true)}
                          className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${updateStatus === "checking" ? "animate-spin" : ""}`} />
                          Verificar Atualizações
                        </button>
                      </div>

                      <label className="flex items-center gap-2 pt-2 border-t border-zinc-800/80 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={config.autoCheckUpdates ?? true}
                          onChange={(e) => updateConfig({ autoCheckUpdates: e.target.checked })}
                          className="h-4 w-4 accent-purple-500 rounded cursor-pointer"
                        />
                        <span className="text-xs text-zinc-300">Verificar atualizações automaticamente ao iniciar o RAVIX</span>
                      </label>
                    </div>

                    {/* Status da Verificação */}
                    {updateStatus === "checking" && (
                      <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center gap-3">
                        <RefreshCw className="h-4 w-4 text-purple-400 animate-spin" />
                        <span className="text-xs text-purple-200">Procurando atualizações...</span>
                      </div>
                    )}

                    {updateStatus === "up-to-date" && (
                      <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-3">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        <span className="text-xs text-emerald-200">Seu RAVIX está atualizado.</span>
                      </div>
                    )}

                    {updateStatus === "error" && (
                      <div className="p-3 rounded-xl bg-zinc-800/80 border border-zinc-700 flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                          <AlertTriangle className="h-4 w-4 text-amber-400" />
                          <span>Não foi possível verificar atualizações. Tente novamente.</span>
                        </div>
                        <p className="text-[11px] text-zinc-400">
                          {updateError || "Servidor remoto indisponível ou sem conexão ativa com a internet."}
                        </p>
                      </div>
                    )}

                    {/* Atualização Disponível */}
                    {updateStatus === "available" && updateObj && (
                      <div className="p-4 rounded-xl bg-purple-950/30 border border-purple-500/50 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-purple-400" />
                            <span className="text-sm font-bold text-white">Nova versão disponível: RAVIX V{updateObj.version}</span>
                          </div>
                        </div>

                        {updateObj.body && (
                          <div className="p-3 rounded-lg bg-[#090B0E] border border-zinc-800 text-xs text-zinc-300 whitespace-pre-wrap font-sans">
                            {updateObj.body}
                          </div>
                        )}

                        {(isRecording || isExporting) ? (
                          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                            <span>
                              {isRecording
                                ? "Uma gravação está em andamento. Pare a gravação antes de instalar a atualização."
                                : "Uma exportação de vídeo está em andamento. Aguarde a finalização antes de atualizar."}
                            </span>
                          </div>
                        ) : null}

                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            disabled={isRecording || isExporting}
                            onClick={handleInstallUpdate}
                            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white flex items-center gap-2 transition-all cursor-pointer disabled:opacity-40"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Atualizar Agora
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowSettings(false)}
                            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 transition-colors cursor-pointer"
                          >
                            Depois
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Progresso do Download */}
                    {updateStatus === "downloading" && (
                      <div className="p-4 rounded-xl bg-[#121620] border border-purple-500/40 space-y-3">
                        <div className="flex items-center justify-between text-xs font-semibold text-white">
                          <span>Baixando atualização...</span>
                          <span className="font-mono text-purple-400">{updateProgress?.percent || 0}%</span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-purple-500 to-emerald-400 transition-all duration-150"
                            style={{ width: `${updateProgress?.percent || 0}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-zinc-400">
                          <span>
                            {updateProgress?.downloaded ? `${(updateProgress.downloaded / (1024 * 1024)).toFixed(1)} MB` : "Iniciando download..."}
                            {updateProgress?.total ? ` de ${(updateProgress.total / (1024 * 1024)).toFixed(1)} MB` : ""}
                          </span>
                          <span>Preparando instalação...</span>
                        </div>
                      </div>
                    )}

                    {updateStatus === "downloaded" && (
                      <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-xs text-emerald-200 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                          <span>Atualização baixada e pronta! Reiniciando o RAVIX...</span>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await relaunch();
                            } catch (e) {
                              console.error(e);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs shrink-0 cursor-pointer transition-colors"
                        >
                          Reiniciar Agora
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Aba Sobre */}
                {settingsTab === "sobre" && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white mb-1">Sobre o RAVIX</h3>
                      <p className="text-xs text-zinc-400">Informações técnicas e de desenvolvimento.</p>
                    </div>

                    <div className="p-4 rounded-xl bg-[#121620] border border-zinc-800 space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center">
                          <Disc className="h-5 w-5 text-purple-400" />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-white">RAVIX</div>
                          <div className="text-xs text-purple-300">Gravador & Editor de Highlights PvP</div>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-zinc-800/80 text-xs text-zinc-300 space-y-1.5 font-mono">
                        <div>Versão: <span className="text-white font-bold">{appVersion ? `${appVersion}-beta` : "..."}</span></div>
                        <div>Plataforma: <span className="text-white">Windows 10 / 11 (x64)</span></div>
                        <div>Motor Gráfico: <span className="text-purple-300">Direct3D11 Video Processor</span></div>
                        <div>Captura: <span className="text-purple-300">Windows Graphics Capture (WGC)</span></div>
                        <div>Codificação: <span className="text-purple-300">Windows Media Foundation Hardware H.264</span></div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
