import { useEffect, useRef, useState, useCallback } from "react";
import { Peer, type DataConnection, type MediaConnection } from "peerjs";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Radio,
  Tv,
  Users,
  Copy,
  Check,
  Play,
  Square,
  ExternalLink,
  ShieldCheck,
  Activity,
  Volume2,
  VolumeX,
  Eye,
  Share2,
  Sparkles,
  Zap,
  Loader2,
  ArrowLeft,
  LogIn,
  Maximize2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import type { StreamMode, StreamStatus, SpectatorStatus, StreamTelemetry, SpectatorPeer } from "./types";

function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RAVIX-${code}`;
}

const GOOGLE_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

export function StreamView() {
  // Modo de operação da aba: "idle" (painel unificado inicial), "host" (transmitindo) ou "spectator" (assistindo)
  const [mode, setMode] = useState<StreamMode>("idle");

  // ==================== ESTADO DO HOST ====================
  const [roomId, setRoomId] = useState<string>("");
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("Pronto para criar uma sala");

  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const [spectators, setSpectators] = useState<SpectatorPeer[]>([]);
  const activeConnectionsRef = useRef<Map<string, { dataConn: DataConnection; mediaConn?: MediaConnection }>>(new Map());

  const [telemetry, setTelemetry] = useState<StreamTelemetry>({
    width: 0,
    height: 0,
    fps: 0,
    elapsedSecs: 0,
    hasAudio: false,
    hasMic: false,
    bitrateEstimateKbps: 0,
  });

  // Tela de Teste de Espectador (Loopback do Host)
  const [showTestViewer, setShowTestViewer] = useState(false);
  const [testStream, setTestStream] = useState<MediaStream | null>(null);
  const [testStatus, setTestStatus] = useState<string>("Desconectado");
  const [testError, setTestError] = useState<string | null>(null);
  const [testLatencyMs, setTestLatencyMs] = useState<number | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const testVideoRef = useRef<HTMLVideoElement | null>(null);
  const hostPeerRef = useRef<Peer | null>(null);
  const testPeerRef = useRef<Peer | null>(null);

  // ==================== ESTADO DO ESPECTADOR (VIEWER IN-APP) ====================
  const [joinRoomInput, setJoinRoomInput] = useState<string>("");
  const [joinNicknameInput, setJoinNicknameInput] = useState<string>("");
  const [spectatorRoomId, setSpectatorRoomId] = useState<string>("");
  const [spectatorStatus, setSpectatorStatus] = useState<SpectatorStatus>("idle");
  const [spectatorStatusMsg, setSpectatorStatusMsg] = useState<string>("Desconectado");
  const [spectatorStream, setSpectatorStream] = useState<MediaStream | null>(null);
  const [spectatorLatencyMs, setSpectatorLatencyMs] = useState<number | null>(null);
  const [spectatorAudioMuted, setSpectatorAudioMuted] = useState(false);

  const spectatorVideoRef = useRef<HTMLVideoElement | null>(null);
  const spectatorPeerRef = useRef<Peer | null>(null);
  const spectatorDataConnRef = useRef<DataConnection | null>(null);

  // Temporizador de Transmissão do Host
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (streamStatus === "streaming") {
      timer = setInterval(() => {
        setTelemetry((prev) => ({
          ...prev,
          elapsedSecs: prev.elapsedSecs + 1,
        }));
      }, 1000);
    } else {
      setTelemetry((prev) => ({ ...prev, elapsedSecs: 0 }));
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [streamStatus]);

  // Atualizar elemento de vídeo local (Host)
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

  // Atualizar elemento de vídeo de teste (Host Loopback)
  useEffect(() => {
    if (testVideoRef.current) {
      testVideoRef.current.srcObject = testStream;
    }
  }, [testStream]);

  // Atualizar elemento de vídeo do Espectador in-app
  useEffect(() => {
    if (spectatorVideoRef.current) {
      spectatorVideoRef.current.srcObject = spectatorStream;
    }
  }, [spectatorStream]);

  // Limpeza geral ao desmontar componente
  useEffect(() => {
    return () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }
      if (hostPeerRef.current) {
        hostPeerRef.current.destroy();
        hostPeerRef.current = null;
      }
      if (testPeerRef.current) {
        testPeerRef.current.destroy();
        testPeerRef.current = null;
      }
      if (spectatorPeerRef.current) {
        spectatorPeerRef.current.destroy();
        spectatorPeerRef.current = null;
      }
      activeConnectionsRef.current.clear();
    };
  }, [mediaStream]);

  // ==================== LÓGICA DO HOST ====================

  const handleCreateRoom = useCallback(() => {
    if (hostPeerRef.current) {
      hostPeerRef.current.destroy();
      hostPeerRef.current = null;
    }

    const newRoomId = generateRoomId();
    setRoomId(newRoomId);
    setMode("host");
    setStreamStatus("creating_room");
    setStatusMessage("Iniciando sala de transmissão...");

    try {
      const peer = new Peer(newRoomId.trim(), {
        debug: 1,
        config: {
          iceServers: GOOGLE_ICE_SERVERS,
        },
      });

      peer.on("open", (id) => {
        hostPeerRef.current = peer;
        setStreamStatus("room_ready");
        setStatusMessage(`Sala pronta: ${id}`);
      });

      peer.on("connection", (dataConn) => {
        const peerId = dataConn.peer;
        activeConnectionsRef.current.set(peerId, { dataConn });
        setSpectators((prev) => [
          ...prev.filter((s) => s.id !== peerId),
          { id: peerId, connectedAt: Date.now() },
        ]);

        dataConn.on("open", () => {
          dataConn.send({
            type: "ROOM_INFO",
            title: "RAVIX Stream",
            status: streamStatus === "streaming" ? "STREAMING" : "READY",
          });

          if (mediaStream) {
            const call = peer.call(peerId, mediaStream);
            const entry = activeConnectionsRef.current.get(peerId);
            if (entry) entry.mediaConn = call;
          }
        });

        dataConn.on("data", (data: any) => {
          if (data && typeof data === "object") {
            if (data.type === "SPECTATOR_JOIN" && data.name) {
              const displayName = String(data.name).trim().slice(0, 30);
              setSpectators((prev) =>
                prev.map((s) => (s.id === peerId ? { ...s, name: displayName } : s))
              );
            }
          }
        });

        dataConn.on("close", () => {
          activeConnectionsRef.current.delete(peerId);
          setSpectators((prev) => prev.filter((s) => s.id !== peerId));
        });

        dataConn.on("error", () => {
          activeConnectionsRef.current.delete(peerId);
          setSpectators((prev) => prev.filter((s) => s.id !== peerId));
        });
      });

      peer.on("call", (mediaConn) => {
        if (mediaStream) {
          mediaConn.answer(mediaStream);
        }
      });

      peer.on("error", (err) => {
        console.error("Erro no Host:", err);
        setStreamStatus("error");
        setStatusMessage(`Falha na sala: ${err.type || err.message}`);
      });
    } catch (err: any) {
      setStreamStatus("error");
      setStatusMessage(`Erro ao inicializar sala: ${err?.message || String(err)}`);
    }
  }, [mediaStream, streamStatus]);

  const handleStartCapture = async () => {
    try {
      setStatusMessage("Solicitando permissão de captura de tela ao Windows...");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: true,
      });

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      if (videoTrack) {
        const settings = videoTrack.getSettings();
        setTelemetry((prev) => ({
          ...prev,
          width: settings.width || 1920,
          height: settings.height || 1080,
          fps: Math.round(settings.frameRate || 60),
          hasAudio: !!audioTrack,
        }));

        videoTrack.onended = () => {
          handleStopCapture();
        };
      }

      setMediaStream(stream);
      setStreamStatus("streaming");
      setStatusMessage("Transmissão ativa e compartilhando!");

      if (hostPeerRef.current) {
        activeConnectionsRef.current.forEach((connData, peerId) => {
          try {
            const call = hostPeerRef.current!.call(peerId, stream);
            connData.mediaConn = call;
            connData.dataConn.send({ type: "STREAM_STARTED" });
          } catch (e) {
            console.error(`Erro ao enviar stream para ${peerId}:`, e);
          }
        });
      }
    } catch (err: any) {
      console.error("Falha ao capturar tela:", err);
      if (err.name !== "NotAllowedError") {
        setStatusMessage(`Erro na captura: ${err.message || String(err)}`);
      } else {
        setStatusMessage("Captura cancelada pelo usuário.");
      }
    }
  };

  const handleStopCapture = () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
    setStreamStatus(hostPeerRef.current ? "room_ready" : "idle");
    setStatusMessage("Compartilhamento de tela finalizado.");

    activeConnectionsRef.current.forEach(({ dataConn }) => {
      try {
        dataConn.send({ type: "STREAM_STOPPED" });
      } catch {}
    });
  };

  // Limpeza completa ao fechar sala pelo Host: reseta tela e volta ao Idle imediatamente
  const handleCloseRoom = () => {
    handleStopCapture();
    if (hostPeerRef.current) {
      hostPeerRef.current.destroy();
      hostPeerRef.current = null;
    }
    handleStopTestViewer();
    activeConnectionsRef.current.clear();
    setSpectators([]);
    setRoomId("");
    setMediaStream(null);
    setStreamStatus("idle");
    setMode("idle");
    setStatusMessage("Pronto para criar uma sala");
    setIsAudioMuted(false);
    setTelemetry({
      width: 0,
      height: 0,
      fps: 0,
      elapsedSecs: 0,
      hasAudio: false,
      hasMic: false,
      bitrateEstimateKbps: 0,
    });
  };

  // Teste local do Host
  const handleStartTestViewer = () => {
    if (!roomId) return;
    if (testPeerRef.current) {
      testPeerRef.current.destroy();
      testPeerRef.current = null;
    }

    setTestStatus("Conectando teste local...");
    setTestError(null);
    const t0 = performance.now();

    try {
      const viewerPeer = new Peer({
        debug: 1,
        config: {
          iceServers: GOOGLE_ICE_SERVERS,
        },
      });

      viewerPeer.on("open", () => {
        setTestStatus("Conectando à sua sala de transmissão...");
        const dataConn = viewerPeer.connect(roomId.trim(), { reliable: true });

        dataConn.on("open", () => {
          setTestStatus("Conexão estabelecida. Aguardando o vídeo...");
          setTestLatencyMs(Math.round(performance.now() - t0));
        });

        dataConn.on("close", () => {
          setTestStatus("Desconectado pelo host.");
          setTestStream(null);
        });
      });

      viewerPeer.on("call", (mediaConn) => {
        setTestStatus("Recebendo transmissão ao vivo...");
        mediaConn.answer();

        mediaConn.on("stream", (remoteStream) => {
          setTestStream(remoteStream);
          setTestStatus("Transmissão ao vivo funcionando com sucesso!");
          setTestError(null);
          setTestLatencyMs(Math.round(performance.now() - t0));
        });

        mediaConn.on("close", () => {
          setTestStatus("Chamada finalizada.");
          setTestStream(null);
        });
      });

      viewerPeer.on("error", (err: any) => {
        let msg = `Erro no teste: ${err?.type || err?.message || "falha de conexão"}`;
        if (err?.type === "peer-unavailable") {
          msg = "A sala local ainda não foi inicializada ou o host não está ativo.";
        }
        setTestError(msg);
        setTestStatus(msg);
      });

      testPeerRef.current = viewerPeer;
      setShowTestViewer(true);
    } catch (e: any) {
      const msg = `Falha ao iniciar teste: ${e?.message || String(e)}`;
      setTestError(msg);
      setTestStatus(msg);
    }
  };

  const handleStopTestViewer = () => {
    if (testPeerRef.current) {
      testPeerRef.current.destroy();
      testPeerRef.current = null;
    }
    setTestStream(null);
    setTestError(null);
    setShowTestViewer(false);
    setTestStatus("Desconectado");
  };

  // ==================== LÓGICA DO ESPECTADOR (ENTRAR COM CÓDIGO NO APP) ====================

  const handleJoinAsSpectator = () => {
    const target = joinRoomInput.trim().toUpperCase();
    if (!target) return;

    setSpectatorRoomId(target);
    setMode("spectator");
    setSpectatorStatus("connecting");
    setSpectatorStatusMsg(`Conectando à sala ${target}...`);
    const t0 = performance.now();

    if (spectatorPeerRef.current) {
      spectatorPeerRef.current.destroy();
      spectatorPeerRef.current = null;
    }

    try {
      const viewerPeer = new Peer({
        debug: 1,
        config: {
          iceServers: GOOGLE_ICE_SERVERS,
        },
      });

      viewerPeer.on("open", (myId) => {
        setSpectatorStatusMsg("Registrado na rede. Conectando ao streamer...");
        const conn = viewerPeer.connect(target, { reliable: true });
        spectatorDataConnRef.current = conn;

        conn.on("open", () => {
          setSpectatorStatus("connected");
          setSpectatorStatusMsg("Conectado! Aguardando o streamer iniciar o compartilhamento...");
          setSpectatorLatencyMs(Math.round(performance.now() - t0));

          const nickname = joinNicknameInput.trim() || "Amigo no RAVIX";
          conn.send({
            type: "SPECTATOR_JOIN",
            name: nickname,
            id: myId,
          });
        });

        conn.on("data", (data: any) => {
          if (data?.type === "STREAM_STARTED") {
            setSpectatorStatusMsg("Recebendo transmissão ao vivo...");
          } else if (data?.type === "STREAM_STOPPED") {
            setSpectatorStatus("connected");
            setSpectatorStatusMsg("O streamer pausou o compartilhamento de tela.");
          }
        });

        conn.on("close", () => {
          setSpectatorStatus("ended");
          setSpectatorStatusMsg("A sala foi encerrada pelo streamer.");
        });

        conn.on("error", () => {
          setSpectatorStatus("error");
          setSpectatorStatusMsg("A sala não foi encontrada ou o host encerrou a transmissão.");
        });
      });

      viewerPeer.on("call", (mediaConn) => {
        setSpectatorStatusMsg("Recebendo vídeo e áudio...");
        mediaConn.answer();

        mediaConn.on("stream", (remoteStream) => {
          setSpectatorStream(remoteStream);
          setSpectatorStatus("streaming");
          setSpectatorStatusMsg("Assistindo transmissão ao vivo!");
          setSpectatorLatencyMs(Math.round(performance.now() - t0));
        });

        mediaConn.on("close", () => {
          setSpectatorStatus("ended");
          setSpectatorStatusMsg("A transmissão foi finalizada pelo streamer.");
          setSpectatorStream(null);
        });
      });

      viewerPeer.on("error", (err: any) => {
        console.warn("Viewer error:", err);
        setSpectatorStatus("error");
        if (err?.type === "peer-unavailable") {
          setSpectatorStatusMsg("A sala não foi encontrada ou o host encerrou a transmissão.");
        } else if (err?.type === "network" || err?.type === "server-error") {
          setSpectatorStatusMsg("Falha de conexão com os servidores. Verifique sua conexão com a internet.");
        } else {
          setSpectatorStatusMsg(`Não foi possível conectar: ${err?.type || err?.message || "falha de conexão"}`);
        }
      });

      spectatorPeerRef.current = viewerPeer;
    } catch (e: any) {
      setSpectatorStatus("error");
      setSpectatorStatusMsg(`Erro ao conectar: ${e?.message || String(e)}`);
    }
  };

  // Limpeza completa ao sair da sala do espectador: reseta tela e volta ao Idle imediatamente
  const handleLeaveSpectator = () => {
    if (spectatorDataConnRef.current) {
      try {
        spectatorDataConnRef.current.close();
      } catch {}
      spectatorDataConnRef.current = null;
    }
    if (spectatorPeerRef.current) {
      try {
        spectatorPeerRef.current.destroy();
      } catch {}
      spectatorPeerRef.current = null;
    }
    if (spectatorStream) {
      try {
        spectatorStream.getTracks().forEach((track) => track.stop());
      } catch {}
    }
    if (spectatorVideoRef.current) {
      spectatorVideoRef.current.srcObject = null;
    }

    setSpectatorStream(null);
    setSpectatorRoomId("");
    setSpectatorStatus("idle");
    setSpectatorStatusMsg("Desconectado");
    setSpectatorLatencyMs(null);
    setSpectatorAudioMuted(false);
    setMode("idle");
  };

  const toggleSpectatorAudio = () => {
    if (spectatorVideoRef.current) {
      const nextMute = !spectatorAudioMuted;
      spectatorVideoRef.current.muted = nextMute;
      setSpectatorAudioMuted(nextMute);
    }
  };

  const toggleSpectatorFullscreen = () => {
    if (spectatorVideoRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        spectatorVideoRef.current.requestFullscreen().catch(() => {});
      }
    }
  };

  // Links Oficiais do Host (NUNCA apontam para localhost; sempre para o GitHub Pages oficial)
  const viewerWebUrl = roomId
    ? `https://ivyfated.github.io/ravix-updates/watch.html?room=${encodeURIComponent(roomId)}`
    : "";

  const handleCopyLink = () => {
    if (!viewerWebUrl) return;
    navigator.clipboard.writeText(viewerWebUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyCode = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Abrir Web sempre na URL oficial hospedada do GitHub Pages
  const handleOpenWeb = async () => {
    if (!viewerWebUrl) return;
    try {
      await openUrl(viewerWebUrl);
    } catch {
      window.open(viewerWebUrl, "_blank");
    }
  };

  const formatElapsed = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const hrs = Math.floor(mins / 60);
    return `${hrs.toString().padStart(2, "0")}:${(mins % 60).toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#090B0E] text-zinc-100 overflow-y-auto p-4 md:p-6 gap-5">
      {/* ==================== BARRA SUPERIOR GLOBAL ==================== */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-[#0E1218] border border-zinc-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-rose-500/20 to-purple-500/20 border border-rose-500/30 text-rose-400">
            <Radio className="h-5 w-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-wide">
                TRANSMISSÃO AO VIVO
              </h1>
              {mode === "host" && streamStatus === "streaming" && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse">
                  AO VIVO
                </span>
              )}
              {mode === "spectator" && spectatorStatus === "streaming" && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse">
                  ASSISTINDO AO VIVO
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              <span>{mode === "spectator" ? spectatorStatusMsg : statusMessage}</span>
            </p>
          </div>
        </div>

        {/* Controles no Topo para Modo Host Ativo */}
        {mode === "host" && streamStatus !== "idle" && (
          <div className="flex items-center gap-3">
            {streamStatus === "streaming" && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-300 font-bold text-xs animate-pulse">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                <span>AO VIVO • {formatElapsed(telemetry.elapsedSecs)}</span>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#121620] border border-zinc-800 text-xs font-semibold text-zinc-300">
              <Users className="h-3.5 w-3.5 text-purple-400" />
              <span>{spectators.length} {spectators.length === 1 ? "espectador" : "espectadores"}</span>
            </div>

            {streamStatus === "streaming" ? (
              <button
                onClick={handleStopCapture}
                className="px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg cursor-pointer"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                Parar Transmissão
              </button>
            ) : (
              <button
                onClick={handleStartCapture}
                className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-rose-500 hover:opacity-90 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg cursor-pointer"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Compartilhar Tela & Áudio
              </button>
            )}

            <button
              onClick={handleCloseRoom}
              className="px-3 py-1.5 rounded-xl bg-[#171C26] hover:bg-red-500/20 hover:text-red-300 border border-zinc-800 text-zinc-300 font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
              title="Encerrar sessão da sala e voltar ao início"
            >
              <Square className="h-3 w-3" />
              Fechar Sala
            </button>
          </div>
        )}

        {/* Controles no Topo para Modo Espectador */}
        {mode === "spectator" && (
          <div className="flex items-center gap-3">
            {spectatorLatencyMs !== null && (
              <div className="px-3 py-1.5 rounded-xl bg-[#121620] border border-zinc-800 text-xs font-mono text-emerald-400">
                Latência: {spectatorLatencyMs}ms
              </div>
            )}
            <button
              onClick={handleLeaveSpectator}
              className="px-3.5 py-1.5 rounded-xl bg-[#171C26] hover:bg-red-500/20 hover:text-red-300 border border-zinc-800 text-zinc-300 font-semibold text-xs flex items-center gap-2 transition-all cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Sair da Sala
            </button>
          </div>
        )}
      </div>

      {/* ==================== MODO 1: PAINEL OCIOSO UNIFICADO (IDLE: CRIAR OU ENTRAR) ==================== */}
      {mode === "idle" && (
        <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 min-h-[480px]">
          <div className="max-w-4xl w-full grid grid-cols-1 md:grid-cols-2 gap-6 relative">
            <div className="absolute -top-16 left-1/4 w-72 h-72 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-16 right-1/4 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

            {/* CARD 1: CRIAR SALA DE TRANSMISSÃO (HOST) */}
            <div className="flex flex-col justify-between p-6 md:p-8 rounded-3xl bg-gradient-to-b from-[#0E1218] to-[#0A0D12] border border-zinc-800 shadow-2xl relative overflow-hidden group hover:border-purple-500/40 transition-all">
              <div>
                <div className="flex items-center justify-between mb-6">
                  <div className="p-3 rounded-2xl bg-[#121620] border border-purple-500/30 text-rose-400 shadow-lg">
                    <Radio className="h-8 w-8" />
                  </div>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase bg-purple-500/15 text-purple-300 border border-purple-500/30">
                    Transmitir Tela
                  </span>
                </div>

                <h2 className="text-lg md:text-xl font-extrabold text-white mb-2">
                  Criar Sala de Transmissão
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed mb-6">
                  Transmita sua gameplay do FiveM, GTA V ou qualquer tela em tempo real para seus amigos com áudio integrado do jogo e 60 FPS estáveis.
                </p>

                <div className="space-y-2 mb-8">
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <Zap className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    <span>60 FPS nativos com aceleração por hardware</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <Volume2 className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                    <span>Captura direta do áudio do sistema e jogo sem eco</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    <span>Link oficial para amigos assistirem na web ou no app</span>
                  </div>
                </div>
              </div>

              <button
                onClick={handleCreateRoom}
                disabled={streamStatus === "creating_room"}
                className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-purple-600 to-rose-600 hover:opacity-95 text-white font-bold text-xs md:text-sm flex items-center justify-center gap-2.5 shadow-xl shadow-purple-950/40 transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
              >
                {streamStatus === "creating_room" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Criando Sala...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 fill-current" />
                    <span>Criar Sala de Transmissão</span>
                  </>
                )}
              </button>
            </div>

            {/* CARD 2: ASSISTIR TRANSMISSÃO DE UM AMIGO (VIEWER NO APP) */}
            <div className="flex flex-col justify-between p-6 md:p-8 rounded-3xl bg-gradient-to-b from-[#0E1218] to-[#0A0D12] border border-zinc-800 shadow-2xl relative overflow-hidden group hover:border-emerald-500/40 transition-all">
              <div>
                <div className="flex items-center justify-between mb-6">
                  <div className="p-3 rounded-2xl bg-[#121620] border border-emerald-500/30 text-emerald-400 shadow-lg">
                    <Tv className="h-8 w-8" />
                  </div>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    Assistir no App
                  </span>
                </div>

                <h2 className="text-lg md:text-xl font-extrabold text-white mb-2">
                  Entrar com Código da Sala
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed mb-6">
                  Digite o código compartilhado pelo seu amigo para assistir à transmissão dele com máxima fluidez, menor latência e áudio estéreo.
                </p>

                <div className="space-y-3 mb-6">
                  <div>
                    <label className="text-[11px] font-semibold text-zinc-400 mb-1 block">
                      Código / ID da Sala
                    </label>
                    <input
                      type="text"
                      value={joinRoomInput}
                      onChange={(e) => setJoinRoomInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && joinRoomInput.trim()) {
                          handleJoinAsSpectator();
                        }
                      }}
                      placeholder="EX: RAVIX-ALPHA"
                      className="w-full rounded-xl border border-zinc-800 bg-[#121620] px-3.5 py-2.5 text-xs font-mono font-bold text-white focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-zinc-400 mb-1 block">
                      Seu Apelido (opcional)
                    </label>
                    <input
                      type="text"
                      value={joinNicknameInput}
                      onChange={(e) => setJoinNicknameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && joinRoomInput.trim()) {
                          handleJoinAsSpectator();
                        }
                      }}
                      placeholder="Ex: Pedro, Player1"
                      maxLength={30}
                      className="w-full rounded-xl border border-zinc-800 bg-[#121620] px-3.5 py-2 text-xs text-white focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                </div>
              </div>

              <button
                onClick={handleJoinAsSpectator}
                disabled={!joinRoomInput.trim()}
                className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:opacity-95 text-white font-bold text-xs md:text-sm flex items-center justify-center gap-2.5 shadow-xl shadow-emerald-950/40 transition-all cursor-pointer hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <LogIn className="h-4 w-4" />
                <span>Assistir Transmissão no App</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODO 2: ESPECTADOR NO APP DESKTOP (VIEWER SCREEN) ==================== */}
      {mode === "spectator" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-full max-w-5xl aspect-video rounded-2xl bg-black border border-zinc-800 overflow-hidden shadow-2xl relative flex items-center justify-center group">
            <video
              ref={spectatorVideoRef}
              autoPlay
              playsInline
              className={`w-full h-full object-contain ${!spectatorStream ? "hidden" : ""}`}
            />

            {/* Tratamento elegante de Erro / peer-unavailable (Elimina a tela preta e loading eterno) */}
            {(spectatorStatus === "error" || spectatorStatus === "ended") && (
              <div className="flex flex-col items-center justify-center p-8 text-center max-w-md bg-[#090B0E]/95 rounded-2xl border border-red-500/20 shadow-2xl">
                <div className="p-3.5 rounded-2xl bg-red-500/10 text-red-400 border border-red-500/20 mb-3">
                  <AlertCircle className="h-8 w-8" />
                </div>
                <h3 className="text-base font-bold text-white mb-1.5">
                  Transmissão Indisponível
                </h3>
                <p className="text-xs text-zinc-400 mb-6 leading-relaxed">
                  {spectatorStatusMsg}
                </p>
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <button
                    onClick={handleJoinAsSpectator}
                    className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg shadow-purple-950/40"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Tentar Novamente
                  </button>
                  <button
                    onClick={handleLeaveSpectator}
                    className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-[#171C26] hover:bg-[#202735] text-zinc-300 font-semibold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer border border-zinc-800"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Voltar ao Início
                  </button>
                </div>
              </div>
            )}

            {/* Overlay quando ainda está conectando */}
            {!spectatorStream && spectatorStatus !== "error" && spectatorStatus !== "ended" && (
              <div className="flex flex-col items-center justify-center p-8 text-center max-w-md">
                <div className="inline-block animate-spin h-8 w-8 border-3 border-emerald-500 border-t-transparent rounded-full mb-4" />
                <h3 className="text-base font-bold text-white mb-1">
                  {spectatorStatusMsg}
                </h3>
                <p className="text-xs text-zinc-400">
                  Sala: <b className="text-zinc-200">{spectatorRoomId}</b>
                </p>
              </div>
            )}

            {/* Controles de overlay no hover do player */}
            {spectatorStream && (
              <div className="absolute bottom-4 right-4 flex items-center gap-2 bg-black/80 backdrop-blur-md p-1.5 rounded-xl border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={toggleSpectatorAudio}
                  className="p-2 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                  title={spectatorAudioMuted ? "Desmutar som" : "Mutar som"}
                >
                  {spectatorAudioMuted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  onClick={toggleSpectatorFullscreen}
                  className="p-2 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                  title="Tela Cheia"
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Sub-barra de informações da sessão */}
          <div className="w-full max-w-5xl flex items-center justify-between p-3.5 rounded-2xl bg-[#0E1218] border border-zinc-800 text-xs text-zinc-400">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Conectado à sala: <b className="text-white font-mono">{spectatorRoomId}</b></span>
              <span className="text-zinc-600">•</span>
              <span>Assistindo como: <b className="text-zinc-200">{joinNicknameInput.trim() || "Amigo no RAVIX"}</b></span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleLeaveSpectator}
                className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors cursor-pointer"
              >
                Voltar ao Menu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODO 3: HOST ATIVO (ACTIVE DASHBOARD) ==================== */}
      {mode === "host" && streamStatus !== "idle" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 flex-1">
          {/* COLUNA ESQUERDA: PREVIEW PRINCIPAL & RETORNO DO STREAMER (8 colunas) */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            <div className="relative aspect-video rounded-2xl bg-[#050709] border border-zinc-800 overflow-hidden shadow-2xl flex items-center justify-center group">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-contain ${!mediaStream ? "hidden" : ""}`}
              />

              {!mediaStream && (
                <div className="flex flex-col items-center justify-center p-8 text-center max-w-md">
                  <div className="p-4 rounded-2xl bg-[#121620] border border-zinc-800 text-zinc-500 mb-4">
                    <Tv className="h-10 w-10 text-purple-400/80" />
                  </div>
                  <h3 className="text-base font-bold text-white mb-1">
                    Sala pronta para transmitir
                  </h3>
                  <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
                    Clique no botão abaixo para escolher a janela do FiveM, jogo ou monitor completo para iniciar o envio de vídeo e som.
                  </p>
                  <button
                    onClick={handleStartCapture}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg cursor-pointer hover:opacity-95"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    Compartilhar Tela & Áudio
                  </button>
                </div>
              )}

              {/* Overlay de Telemetria sobre o Player */}
              {mediaStream && (
                <div className="absolute top-3 left-3 flex flex-wrap items-center gap-2 pointer-events-none">
                  <span className="px-2.5 py-1 rounded-lg bg-black/75 backdrop-blur-md border border-white/10 text-[11px] font-mono text-emerald-400 flex items-center gap-1.5">
                    <Activity className="h-3 w-3" />
                    {telemetry.width}x{telemetry.height} @ {telemetry.fps} FPS
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-black/75 backdrop-blur-md border border-white/10 text-[11px] font-mono text-purple-300 flex items-center gap-1.5">
                    {telemetry.hasAudio ? (
                      <>
                        <Volume2 className="h-3 w-3 text-emerald-400" />
                        Áudio do Jogo Ativo
                      </>
                    ) : (
                      <>
                        <VolumeX className="h-3 w-3 text-zinc-500" />
                        Sem Áudio
                      </>
                    )}
                  </span>
                </div>
              )}

              {/* Controles de overlay no hover */}
              {mediaStream && (
                <div className="absolute bottom-3 right-3 flex items-center gap-2 bg-black/80 backdrop-blur-md p-1.5 rounded-xl border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setIsAudioMuted(!isAudioMuted)}
                    className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white cursor-pointer"
                    title={isAudioMuted ? "Desmutar prévia local" : "Mutar prévia local"}
                  >
                    {isAudioMuted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
                  </button>
                </div>
              )}
            </div>

            {/* Teste Local de Transmissão */}
            <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-purple-400" />
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    Teste Local de Transmissão
                  </h3>
                </div>
                {!showTestViewer ? (
                  <button
                    onClick={handleStartTestViewer}
                    className="px-3 py-1 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Testar Transmissão no App
                  </button>
                ) : (
                  <button
                    onClick={handleStopTestViewer}
                    className="px-3 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/40 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                    Fechar Teste
                  </button>
                )}
              </div>

              {showTestViewer ? (
                <div className="space-y-2 pt-2 border-t border-zinc-800">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                      Status: <b className="text-zinc-200">{testStatus}</b>
                    </span>
                    {testLatencyMs !== null && !testError && (
                      <span className="font-mono text-emerald-400 text-[11px]">
                        Latência: {testLatencyMs}ms
                      </span>
                    )}
                  </div>

                  <div className="relative aspect-video max-h-72 w-full rounded-xl bg-black border border-purple-500/30 overflow-hidden flex items-center justify-center shadow-inner">
                    <video
                      ref={testVideoRef}
                      autoPlay
                      playsInline
                      controls
                      className={`w-full h-full object-contain ${!testStream || testError ? "hidden" : ""}`}
                    />

                    {/* Exibição de erro claro no teste (sem tela preta infinita) */}
                    {testError && (
                      <div className="text-center p-4 max-w-sm">
                        <AlertCircle className="h-6 w-6 text-amber-400 mx-auto mb-2" />
                        <p className="text-xs text-zinc-300 mb-3">{testError}</p>
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={handleStartTestViewer}
                            className="px-3 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Tentar Novamente
                          </button>
                          <button
                            onClick={handleStopTestViewer}
                            className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] cursor-pointer"
                          >
                            Fechar
                          </button>
                        </div>
                      </div>
                    )}

                    {!testStream && !testError && (
                      <div className="text-center p-4">
                        <div className="inline-block animate-spin h-6 w-6 border-2 border-purple-500 border-t-transparent rounded-full mb-2" />
                        <p className="text-xs text-zinc-400">Aguardando início do vídeo...</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  Abra a visualização de teste para conferir se o áudio e o vídeo estão funcionando com perfeição antes de enviar o link para seus amigos.
                </p>
              )}
            </div>
          </div>

          {/* COLUNA DIREITA: DADOS DA SALA & ESPECTADORES (4 colunas) */}
          <div className="lg:col-span-4 flex flex-col gap-4">
            <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-4 shadow-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                  <Share2 className="h-4 w-4 text-emerald-400" />
                  Sala Ativa
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  ONLINE
                </span>
              </div>

              {/* Código da Sala */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-zinc-400">
                  Código da Sala
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={roomId}
                    className="flex-1 rounded-xl border border-zinc-800 bg-[#121620] px-3 py-2 text-xs font-mono font-bold text-white select-all"
                  />
                  <button
                    onClick={handleCopyCode}
                    className="p-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-300 transition-colors cursor-pointer"
                    title="Copiar Código da Sala"
                  >
                    {copiedCode ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Link do Player para Espectadores */}
              <div className="space-y-2 pt-2 border-t border-zinc-800/80">
                <label className="text-[11px] font-semibold text-zinc-400">
                  Link para Amigos Assistirem
                </label>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={viewerWebUrl}
                    className="flex-1 rounded-xl border border-zinc-800 bg-[#121620] px-3 py-2 text-[11px] font-mono text-zinc-400 truncate select-all"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="p-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-300 transition-colors cursor-pointer"
                    title="Copiar Link"
                  >
                    {copiedLink ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={handleCopyLink}
                    className="py-1.5 px-3 rounded-lg bg-[#121620] hover:bg-[#1A1F2C] border border-zinc-800 text-[11px] font-medium text-zinc-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Share2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Compartilhar</span>
                  </button>

                  {/* Botão Abrir Web que abre OBRIGATORIAMENTE a URL oficial do GitHub Pages no navegador padrão */}
                  <button
                    type="button"
                    onClick={handleOpenWeb}
                    className="py-1.5 px-3 rounded-lg bg-[#121620] hover:bg-[#1A1F2C] border border-zinc-800 text-[11px] font-medium text-zinc-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    title="Abrir no Navegador Web Oficial"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-purple-400" />
                    <span>Abrir Web</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Lista de Espectadores */}
            <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-3 shadow-xl">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                  <Users className="h-4 w-4 text-purple-400" />
                  Espectadores Conectados ({spectators.length})
                </h3>
              </div>

              {spectators.length === 0 ? (
                <div className="py-6 text-center text-xs text-zinc-500 border border-dashed border-zinc-800/80 rounded-xl">
                  Nenhum amigo conectado no momento.
                  <br />
                  Envie o código ou link da sala.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {spectators.map((spec, i) => (
                    <div
                      key={spec.id}
                      className="flex items-center justify-between p-2.5 rounded-xl bg-[#121620] border border-zinc-800/60 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span className="font-medium text-zinc-200">
                          {spec.name ? spec.name : `Amigo #${i + 1}`}
                        </span>
                        <span className="font-mono text-[10px] text-zinc-500">
                          ({spec.id.slice(0, 8)})
                        </span>
                      </div>
                      <span className="text-[10px] text-emerald-400 font-semibold">Online</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Dica de Segurança e Privacidade */}
            <div className="p-3.5 rounded-2xl bg-[#0E1218]/50 border border-zinc-800/60 text-[11px] text-zinc-400 space-y-1">
              <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Transmissão Direta e Privada
              </span>
              <p>
                O vídeo e o áudio são transmitidos diretamente para seus amigos com conexão criptografada, sem intermediários ou gravações externas.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
