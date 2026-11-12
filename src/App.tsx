import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Disc,
  Film,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Keyboard,
  Mic,
  MicOff,
  Monitor,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import type {
  RecordedFileInfo,
  RecorderStatus,
  RecordingConfig,
  SystemCapabilities,
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
  const [caps, setCaps] = useState<SystemCapabilities | null>(null);
  const [config, setConfig] = useState<RecordingConfig | null>(null);
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [files, setFiles] = useState<RecordedFileInfo[]>([]);
  const [hotkeyInput, setHotkeyInput] = useState("F9");
  const [customSeconds, setCustomSeconds] = useState("");
  const [uiNotice, setUiNotice] = useState<{ type: "err" | "ok"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
    } catch (e) {
      setUiNotice({ type: "err", text: String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refreshAll();
    const unlistenPromise = listen<RecorderStatus>("recorder-status", (ev) => {
      setStatus(ev.payload);
      if (ev.payload.state === "idle" || ev.payload.state === "error") {
        invoke<RecordedFileInfo[]>("list_recorded_files").then(setFiles).catch(() => {});
      }
    });
    return () => {
      unlistenPromise.then((u) => u());
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

  const selectedSource = useMemo(
    () => caps?.sources.find((s) => s.id === config?.sourceId && s.kind === config?.sourceKind),
    [caps, config]
  );

  const validResolutions = useMemo(() => {
    const srcH = selectedSource?.height ?? 1080;
    const opts = [{ value: "native", label: `Nativa (${selectedSource ? `${selectedSource.width}x${selectedSource.height}` : "Original"})` }];
    if (srcH >= 1080) opts.push({ value: "1080p", label: "1080p (Full HD)" });
    if (srcH >= 900) opts.push({ value: "900p", label: "900p (HD+)" });
    if (srcH >= 720) opts.push({ value: "720p", label: "720p (HD — Menor carga)" });
    return opts;
  }, [selectedSource]);

  if (!config || !caps || !status) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#090B0E] text-zinc-400">
        Inicializando motor RAVIX...
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
    <div className="min-h-screen bg-[#090B0E] text-zinc-100 flex flex-col">
      {/* Top Bar */}
      <header className="border-b border-zinc-800/80 bg-[#0D1016] px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500/20 to-zinc-900 border border-emerald-500/40 flex items-center justify-center">
            <Disc className={`h-5 w-5 ${isRecording ? "text-red-400 animate-spin" : "text-emerald-400"}`} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-bold tracking-wider text-white">RAVIX</h1>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/70">
                V0.1.1
              </span>
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${stateBadge.cls}`}>
                <span className={`h-2 w-2 rounded-full ${stateBadge.dot}`} />
                {stateBadge.text}
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Captura PvP de baixo impacto • Windows Graphics Capture + Hardware H.264
            </p>
          </div>
        </div>

        {/* Timer + Botão Principal */}
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-2xl font-bold tracking-tight text-white">
              {formatElapsed(status.elapsedSecs)}
              {status.durationLimitSecs ? (
                <span className="text-sm font-normal text-zinc-400">
                  {" / "}
                  {formatElapsed(status.durationLimitSecs)}
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-zinc-400 flex items-center justify-end gap-1.5">
              <Keyboard className="h-3 w-3" />
              Atalho: <span className="text-zinc-200 font-semibold">{config.hotkey}</span>
            </div>
          </div>

          <button
            onClick={handleToggleRecording}
            disabled={isBusy}
            className={`px-5 py-3 rounded-xl font-semibold text-sm flex items-center gap-2.5 transition-all cursor-pointer disabled:opacity-50 ${
              isRecording
                ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-950/50"
                : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-lg shadow-emerald-950/50"
            }`}
          >
            {isRecording ? (
              <>
                <Square className="h-4 w-4 fill-current" />
                Parar Gravação
              </>
            ) : (
              <>
                <Disc className="h-4 w-4" />
                Iniciar Gravação
              </>
            )}
          </button>
        </div>
      </header>

      {/* Alertas */}
      {(uiNotice || status.lastError || status.fpsWarning) && (
        <div className="px-6 pt-3 space-y-2">
          {status.fpsWarning && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>{status.fpsWarning}</span>
            </div>
          )}
          {(status.lastError || uiNotice?.type === "err") && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <span>{uiNotice?.type === "err" ? uiNotice.text : status.lastError}</span>
            </div>
          )}
          {uiNotice?.type === "ok" && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{uiNotice.text}</span>
            </div>
          )}
        </div>
      )}

      {/* Conteúdo Principal */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Coluna Esquerda: Configurações */}
        <div className="lg:col-span-7 space-y-5">
          {/* Fonte de Captura */}
          <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Fonte de Captura</h2>
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
              className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none disabled:opacity-60"
            >
              {caps.sources.map((src) => (
                <option key={`${src.kind}:${src.id}`} value={`${src.kind}:${src.id}`}>
                  {src.isGamePriority ? "[JOGO DETECTADO] " : src.kind === "monitor" ? "[MONITOR] " : "[JANELA] "}
                  {src.title} — {src.width}x{src.height} ({src.processName})
                </option>
              ))}
            </select>

            {selectedSource && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Gamepad2 className="h-3.5 w-3.5" />
                  {selectedSource.kind === "window" ? "Captura direta da janela (WGC)" : "Captura de monitor (WGC)"}
                </span>
                <span>•</span>
                <span>Resolução original: {selectedSource.width}x{selectedSource.height}</span>
              </div>
            )}
          </section>

          {/* Qualidade e Duração */}
          <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">Qualidade, Encoder e Tempo</h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Resolução de Saída</label>
                <select
                  disabled={isRecording}
                  value={config.resolutionMode}
                  onChange={(e) => updateConfig({ resolutionMode: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                >
                  {validResolutions.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Taxa de Quadros (FPS)</label>
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
                <label className="block text-xs text-zinc-400 mb-1.5">Qualidade / Bitrate</label>
                <select
                  disabled={isRecording}
                  value={config.bitrateKbps}
                  onChange={(e) => updateConfig({ bitrateKbps: Number(e.target.value) })}
                  className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                >
                  {BITRATE_OPTIONS.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Encoder H.264 Disponível</label>
                <select
                  disabled={isRecording}
                  value={config.encoderId}
                  onChange={(e) => updateConfig({ encoderId: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
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
                <label className="block text-xs text-zinc-400 mb-1.5">Modo / Duração da Gravação</label>
                <select
                  disabled={isRecording}
                  value={config.durationLimitSecs === null ? "manual" : String(config.durationLimitSecs)}
                  onChange={(e) => {
                    const val = e.target.value === "manual" ? null : Number(e.target.value);
                    updateConfig({ durationLimitSecs: val });
                  }}
                  className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                >
                  {DURATION_PRESETS.map((d) => (
                    <option key={d.label} value={d.value === null ? "manual" : String(d.value)}>
                      {d.label}
                    </option>
                  ))}
                  {config.durationLimitSecs !== null &&
                    !DURATION_PRESETS.some((p) => p.value === config.durationLimitSecs) && (
                      <option value={String(config.durationLimitSecs)}>
                        Personalizado ({config.durationLimitSecs}s)
                      </option>
                    )}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Duração Personalizada (segundos)</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={5}
                    max={86400}
                    disabled={isRecording}
                    placeholder="Ex: 120"
                    value={customSeconds}
                    onChange={(e) => setCustomSeconds(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                  />
                  <button
                    disabled={isRecording || !customSeconds}
                    onClick={() => {
                      const sec = Number(customSeconds);
                      if (sec >= 5) {
                        updateConfig({ durationLimitSecs: sec });
                        setCustomSeconds("");
                      }
                    }}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer disabled:opacity-40"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 pt-1 border-t border-zinc-800/70">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Segmentação Segura (Gravações Longas)</label>
                <select
                  disabled={isRecording}
                  value={config.segmentMinutes === null ? "off" : String(config.segmentMinutes)}
                  onChange={(e) =>
                    updateConfig({
                      segmentMinutes: e.target.value === "off" ? null : Number(e.target.value),
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 disabled:opacity-60"
                >
                  <option value="off">Arquivo único contínuo</option>
                  <option value="15">Dividir a cada 15 minutos</option>
                  <option value="30">Dividir a cada 30 minutos (Recomendado)</option>
                  <option value="60">Dividir a cada 60 minutos</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Atalho Global (Iniciar / Parar)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={hotkeyInput}
                    onChange={(e) => setHotkeyInput(e.target.value)}
                    placeholder="Ex: F9 ou Ctrl+Shift+R"
                    className="w-full rounded-lg border border-zinc-700/80 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100"
                  />
                  <button
                    onClick={handleApplyHotkey}
                    className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 cursor-pointer"
                  >
                    Salvar
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Áudio */}
          <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Áudio (WASAPI 48kHz Estéreo)</h2>
              </div>
              <span className="text-[11px] text-zinc-500">
                Loopback do dispositivo Windows (captura todos os sons nele)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                    {config.systemAudioEnabled ? <Volume2 className="h-3.5 w-3.5 text-emerald-400" /> : <VolumeX className="h-3.5 w-3.5 text-zinc-500" />}
                    Áudio do Sistema
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
                  onChange={(e) =>
                    updateConfig({ systemAudioDeviceId: e.target.value || null })
                  }
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

              <div className="rounded-lg border border-zinc-800 bg-[#090B0E] p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                    {config.micEnabled ? <Mic className="h-3.5 w-3.5 text-emerald-400" /> : <MicOff className="h-3.5 w-3.5 text-zinc-500" />}
                    Microfone
                  </span>
                  <input
                    type="checkbox"
                    disabled={isRecording}
                    checked={config.micEnabled}
                    onChange={(e) => updateConfig({ micEnabled: e.target.checked })}
                    className="h-4 w-4 accent-emerald-500 cursor-pointer"
                  />
                </div>
                <select
                  disabled={isRecording || !config.micEnabled}
                  value={config.micDeviceId ?? ""}
                  onChange={(e) =>
                    updateConfig({ micDeviceId: e.target.value || null })
                  }
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

        {/* Coluna Direita: Telemetria + Armazenamento + Gravações */}
        <div className="lg:col-span-5 space-y-5 flex flex-col">
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
              <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-3">
                <div className="text-[11px] text-zinc-400">FPS Efetivo / Alvo</div>
                <div className="text-base font-bold text-white mt-0.5 font-mono">
                  {status.actualFps.toFixed(1)} <span className="text-xs font-normal text-zinc-500">/ {status.targetFps}</span>
                </div>
              </div>
              <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-3">
                <div className="text-[11px] text-zinc-400">Quadros Gravados / Perdidos</div>
                <div className="text-base font-bold text-white mt-0.5 font-mono">
                  {status.framesWritten}{" "}
                  <span className={`text-xs ${status.framesDropped > 0 ? "text-amber-400" : "text-zinc-500"}`}>
                    ({status.framesDropped} drop)
                  </span>
                </div>
              </div>
              <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-3">
                <div className="text-[11px] text-zinc-400">Uso do RAVIX (CPU / RAM)</div>
                <div className="text-sm font-semibold text-zinc-200 mt-0.5 font-mono">
                  {status.cpuUsagePct.toFixed(1)}% • {status.memoryMb.toFixed(0)} MB
                </div>
              </div>
              <div className="rounded-lg bg-[#090B0E] border border-zinc-800/80 p-3">
                <div className="text-[11px] text-zinc-400">Espaço Livre em Disco</div>
                <div className="text-sm font-semibold text-zinc-200 mt-0.5 font-mono flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                  {status.freeDiskGb.toFixed(2)} GB
                </div>
              </div>
            </div>

            {status.currentFile && (
              <div className="text-[11px] text-zinc-400 bg-[#090B0E] border border-zinc-800/80 rounded-lg px-3 py-2 truncate">
                <span className="text-zinc-500">Arquivo ativo (Seg #{status.currentSegment}): </span>
                <span className="text-zinc-200">{status.currentFile}</span>
              </div>
            )}

            <label className="flex items-center justify-between text-xs text-zinc-300 pt-1 cursor-pointer">
              <span>Ao fechar janela, manter minimizado na bandeja do Windows</span>
              <input
                type="checkbox"
                checked={config.minimizeToTrayOnClose}
                onChange={(e) => updateConfig({ minimizeToTrayOnClose: e.target.checked })}
                className="h-4 w-4 accent-emerald-500 cursor-pointer"
              />
            </label>
          </section>

          {/* Pasta & Vídeos Gravados */}
          <section className="rounded-xl border border-zinc-800/80 bg-[#10141B] p-4 space-y-3 flex-1 flex flex-col min-h-[260px]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Film className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">Vídeos Gravados</h2>
              </div>
              <button
                onClick={() => invoke("open_recordings_folder")}
                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
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

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[260px]">
              {files.length === 0 ? (
                <div className="h-32 flex flex-col items-center justify-center text-xs text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
                  <Clock className="h-5 w-5 mb-1.5 text-zinc-600" />
                  Nenhuma gravação encontrada nesta pasta ainda.
                </div>
              ) : (
                files.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-[#090B0E] px-3 py-2 hover:border-zinc-700 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-200 truncate">{file.filename}</div>
                      <div className="text-[11px] text-zinc-500">
                        {formatBytes(file.sizeBytes)} • {formatDate(file.modifiedTs)}
                      </div>
                    </div>
                    <button
                      onClick={() => invoke("open_video_file", { path: file.path })}
                      className="shrink-0 px-2.5 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <Play className="h-3 w-3 fill-current" />
                      Abrir
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
