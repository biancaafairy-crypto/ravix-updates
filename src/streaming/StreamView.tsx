import { useEffect, useRef, useState, useCallback } from "react";
import { Peer, type DataConnection, type MediaConnection } from "peerjs";
import {
  Radio,
  Tv,
  Users,
  Copy,
  Check,
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Activity,
  Volume2,
  VolumeX,
  Eye,
  Share2,
  Sparkles,
} from "lucide-react";
import type { StreamStatus, StreamTelemetry, SpectatorPeer } from "./types";

function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RAVIX-${code}`;
}

export function StreamView() {
  // Configuração da Sala
  const [roomId, setRoomId] = useState<string>(() => generateRoomId());
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("Sala não inicializada");

  // Mídia & Captura
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Espectadores e Conexões
  const [spectators, setSpectators] = useState<SpectatorPeer[]>([]);
  const activeConnectionsRef = useRef<Map<string, { dataConn: DataConnection; mediaConn?: MediaConnection }>>(new Map());

  // Telemetria da Transmissão
  const [telemetry, setTelemetry] = useState<StreamTelemetry>({
    width: 0,
    height: 0,
    fps: 0,
    elapsedSecs: 0,
    hasAudio: false,
    hasMic: false,
    bitrateEstimateKbps: 0,
  });

  // Tela de Teste de Espectador (Loopback P2P)
  const [showTestViewer, setShowTestViewer] = useState(false);
  const [testStream, setTestStream] = useState<MediaStream | null>(null);
  const [testStatus, setTestStatus] = useState<string>("Desconectado");
  const [testLatencyMs, setTestLatencyMs] = useState<number | null>(null);

  // Elementos de vídeo
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const testVideoRef = useRef<HTMLVideoElement | null>(null);

  // Instâncias PeerJS
  const hostPeerRef = useRef<Peer | null>(null);
  const testPeerRef = useRef<Peer | null>(null);

  // Temporizador de Transmissão
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

  // Atualizar elemento de vídeo local quando o stream mudar
  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = mediaStream;
    }
  }, [mediaStream]);

  // Atualizar elemento de vídeo de teste
  useEffect(() => {
    if (testVideoRef.current) {
      testVideoRef.current.srcObject = testStream;
    }
  }, [testStream]);

  // 1. Criar Sala P2P (Host)
  const handleCreateRoom = useCallback(() => {
    if (hostPeerRef.current) {
      hostPeerRef.current.destroy();
      hostPeerRef.current = null;
    }

    setStreamStatus("creating_room");
    setStatusMessage("Registrando sala no broker P2P...");

    try {
      const peer = new Peer(roomId.trim(), {
        debug: 1,
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
          ],
        },
      });

      peer.on("open", (id) => {
        hostPeerRef.current = peer;
        setStreamStatus("room_ready");
        setStatusMessage(`Sala P2P aberta com ID: ${id}`);
      });

      // Quando um espectador se conecta via DataChannel
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

          // Se já estiver transmitindo tela, liga para o novo espectador imediatamente!
          if (mediaStream) {
            const call = peer.call(peerId, mediaStream);
            const entry = activeConnectionsRef.current.get(peerId);
            if (entry) entry.mediaConn = call;
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

      // Se um espectador ligar para o host
      peer.on("call", (mediaConn) => {
        if (mediaStream) {
          mediaConn.answer(mediaStream);
        }
      });

      peer.on("error", (err) => {
        console.error("Erro no PeerJS Host:", err);
        setStreamStatus("error");
        setStatusMessage(`Falha na sala: ${err.type || err.message}`);
      });
    } catch (err: any) {
      setStreamStatus("error");
      setStatusMessage(`Erro ao instanciar sala: ${err?.message || String(err)}`);
    }
  }, [roomId, mediaStream, streamStatus]);

  // 2. Iniciar Captura de Tela (getDisplayMedia)
  const handleStartCapture = async () => {
    try {
      setStatusMessage("Solicitando permissão de captura de tela ao Windows...");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: true, // Captura o áudio do sistema/jogo!
      });

      // Extrair dimensões reais do vídeo
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
      setStatusMessage("Transmissão P2P ativa e compartilhando!");

      // Enviar stream para todos os espectadores já conectados
      if (hostPeerRef.current) {
        activeConnectionsRef.current.forEach((connData, peerId) => {
          try {
            const call = hostPeerRef.current!.call(peerId, stream);
            connData.mediaConn = call;
            connData.dataConn.send({ type: "STREAM_STARTED" });
          } catch (e) {
            console.error(`Erro ao ligar para ${peerId}:`, e);
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

  // 3. Parar Captura de Tela
  const handleStopCapture = () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      setMediaStream(null);
    }
    setStreamStatus(hostPeerRef.current ? "room_ready" : "idle");
    setStatusMessage("Compartilhamento de tela finalizado.");

    // Notificar espectadores
    activeConnectionsRef.current.forEach(({ dataConn }) => {
      try {
        dataConn.send({ type: "STREAM_STOPPED" });
      } catch {}
    });
  };

  // 4. Fechar Sala
  const handleCloseRoom = () => {
    handleStopCapture();
    if (hostPeerRef.current) {
      hostPeerRef.current.destroy();
      hostPeerRef.current = null;
    }
    activeConnectionsRef.current.clear();
    setSpectators([]);
    setStreamStatus("idle");
    setStatusMessage("Sala encerrada.");
  };

  // 5. Teste de Espectador em Loopback P2P (Requirement 4)
  const handleStartTestViewer = () => {
    if (testPeerRef.current) {
      testPeerRef.current.destroy();
      testPeerRef.current = null;
    }

    setTestStatus("Conectando como espectador...");
    const t0 = performance.now();

    try {
      const viewerPeer = new Peer({
        debug: 1,
        config: {
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        },
      });

      viewerPeer.on("open", (id) => {
        setTestStatus(`Espectador registrado (${id.slice(0, 8)}...). Conectando à sala...`);
        const dataConn = viewerPeer.connect(roomId.trim(), { reliable: true });

        dataConn.on("open", () => {
          setTestStatus("Conexão de dados aberta. Aguardando feed WebRTC...");
          setTestLatencyMs(Math.round(performance.now() - t0));
        });

        dataConn.on("close", () => {
          setTestStatus("Desconectado pelo host.");
          setTestStream(null);
        });
      });

      viewerPeer.on("call", (mediaConn) => {
        setTestStatus("Recebendo chamada P2P do host... Respondendo...");
        mediaConn.answer();

        mediaConn.on("stream", (remoteStream) => {
          setTestStream(remoteStream);
          setTestStatus("Feed P2P conectado e renderizando!");
          setTestLatencyMs(Math.round(performance.now() - t0));
        });

        mediaConn.on("close", () => {
          setTestStatus("Chamada finalizada.");
          setTestStream(null);
        });
      });

      viewerPeer.on("error", (err) => {
        setTestStatus(`Erro no espectador: ${err.type || err.message}`);
      });

      testPeerRef.current = viewerPeer;
      setShowTestViewer(true);
    } catch (e: any) {
      setTestStatus(`Falha ao iniciar teste: ${e?.message || String(e)}`);
    }
  };

  const handleStopTestViewer = () => {
    if (testPeerRef.current) {
      testPeerRef.current.destroy();
      testPeerRef.current = null;
    }
    setTestStream(null);
    setShowTestViewer(false);
    setTestStatus("Desconectado");
  };

  // Links de compartilhamento
  const viewerWebUrl = `https://ivyfated.github.io/ravix-updates/watch.html?room=${encodeURIComponent(roomId)}`;
  const localWebUrl = `http://localhost:5173/watch.html?room=${encodeURIComponent(roomId)}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(viewerWebUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const formatElapsed = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const hrs = Math.floor(mins / 60);
    return `${hrs.toString().padStart(2, "0")}:${(mins % 60).toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#090B0E] text-zinc-100 overflow-y-auto p-4 md:p-6 gap-5">
      {/* ==================== BARRA SUPERIOR DA TRANSMISSÃO ==================== */}
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
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30">
                P2P • Tela Oasis
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5 flex items-center gap-2">
              <span>{statusMessage}</span>
            </p>
          </div>
        </div>

        {/* Badges de Status / Espectadores / Timer */}
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
          ) : streamStatus === "room_ready" ? (
            <button
              onClick={handleStartCapture}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-rose-500 hover:opacity-90 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg cursor-pointer"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Compartilhar Tela & Áudio
            </button>
          ) : (
            <button
              onClick={handleCreateRoom}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-purple-600 to-rose-600 hover:opacity-90 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-lg cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Criar Sala P2P
            </button>
          )}
        </div>
      </div>

      {/* ==================== CORPO PRINCIPAL ==================== */}
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
                  Nenhuma transmissão de tela em andamento
                </h3>
                <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
                  Crie uma sala P2P e clique em <b>"Compartilhar Tela & Áudio"</b> para transmitir FiveM, GTA V ou qualquer tela para seus amigos com baixa latência estilo Tela Oasis / Discord.
                </p>
                {streamStatus === "room_ready" ? (
                  <button
                    onClick={handleStartCapture}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg cursor-pointer hover:opacity-95"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    Iniciar Compartilhamento de Tela
                  </button>
                ) : (
                  <button
                    onClick={handleCreateRoom}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-rose-600 text-white font-bold text-xs flex items-center gap-2 shadow-lg cursor-pointer hover:opacity-95"
                  >
                    <Radio className="h-4 w-4" />
                    Abrir Sala de Transmissão
                  </button>
                )}
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
                  className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white"
                  title={isAudioMuted ? "Desmutar prévia local" : "Mutar prévia local"}
                >
                  {isAudioMuted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>

          {/* ==================== TELA DE TESTE DE ESPECTADOR (LOOPBACK P2P) ==================== */}
          <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-purple-400" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                  Tela de Teste • Feed do Espectador (Loopback P2P)
                </h3>
              </div>
              {!showTestViewer ? (
                <button
                  onClick={handleStartTestViewer}
                  disabled={streamStatus === "idle"}
                  className="px-3 py-1 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Testar como Espectador no App
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
                  {testLatencyMs !== null && (
                    <span className="font-mono text-emerald-400 text-[11px]">
                      Handshake P2P: {testLatencyMs}ms
                    </span>
                  )}
                </div>

                <div className="relative aspect-video max-h-72 w-full rounded-xl bg-black border border-purple-500/30 overflow-hidden flex items-center justify-center shadow-inner">
                  <video
                    ref={testVideoRef}
                    autoPlay
                    playsInline
                    controls
                    className={`w-full h-full object-contain ${!testStream ? "hidden" : ""}`}
                  />
                  {!testStream && (
                    <div className="text-center p-4">
                      <div className="inline-block animate-spin h-6 w-6 border-2 border-purple-500 border-t-transparent rounded-full mb-2" />
                      <p className="text-xs text-zinc-400">Aguardando fluxo WebRTC do host...</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-500">
                Abra o feed de teste para validar localmente que o WebRTC e o PeerJS estão transmitindo áudio e vídeo com sucesso de ponta a ponta antes de enviar para seus amigos.
              </p>
            )}
          </div>
        </div>

        {/* COLUNA DIREITA: CONFIGURAÇÕES DA SALA & COMPARTILHAMENTO (4 colunas) */}
        <div className="lg:col-span-4 flex flex-col gap-4">
          {/* Card: Código da Sala e Conexão P2P */}
          <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                <Share2 className="h-4 w-4 text-emerald-400" />
                Configuração da Sala P2P
              </h2>
              {streamStatus !== "idle" && (
                <span className="h-2 w-2 rounded-full bg-emerald-400" title="Sala Ativa" />
              )}
            </div>

            {/* Input do Código da Sala */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-zinc-400">
                Código / ID da Sala
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={roomId}
                  disabled={streamStatus === "streaming"}
                  onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                  className="flex-1 rounded-xl border border-zinc-800 bg-[#121620] px-3 py-2 text-xs font-mono font-bold text-white focus:outline-none focus:border-purple-500 disabled:opacity-50"
                  placeholder="EX: RAVIX-ALPHA"
                />
                <button
                  onClick={() => setRoomId(generateRoomId())}
                  disabled={streamStatus === "streaming"}
                  className="p-2 rounded-xl bg-[#171C26] hover:bg-[#1E2430] border border-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                  title="Gerar outro ID aleatório"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Ações da Sala */}
            <div className="pt-1 flex flex-col gap-2">
              {streamStatus === "idle" ? (
                <button
                  onClick={handleCreateRoom}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-rose-600 hover:opacity-95 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg cursor-pointer transition-all"
                >
                  <Sparkles className="h-4 w-4" />
                  Criar Sala P2P (Ativar Broker)
                </button>
              ) : (
                <button
                  onClick={handleCloseRoom}
                  className="w-full py-2 rounded-xl bg-[#171C26] hover:bg-red-500/20 hover:text-red-300 border border-zinc-800 text-zinc-300 font-semibold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5" />
                  Fechar Sala
                </button>
              )}
            </div>

            {/* Link de Compartilhamento com Amigos */}
            <div className="space-y-2 pt-2 border-t border-zinc-800/80">
              <label className="text-[11px] font-semibold text-zinc-400 flex items-center justify-between">
                <span>Link do Player para Espectadores</span>
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
                  onClick={handleCopyCode}
                  className="py-1.5 px-3 rounded-lg bg-[#121620] hover:bg-[#1A1F2C] border border-zinc-800 text-[11px] font-medium text-zinc-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>Copiar ID da Sala</span>
                </button>

                <a
                  href={localWebUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="py-1.5 px-3 rounded-lg bg-[#121620] hover:bg-[#1A1F2C] border border-zinc-800 text-[11px] font-medium text-zinc-300 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-purple-400" />
                  <span>Abrir no Browser</span>
                </a>
              </div>
            </div>
          </div>

          {/* Card: Lista de Espectadores Conectados */}
          <div className="rounded-2xl bg-[#0E1218] border border-zinc-800 p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                <Users className="h-4 w-4 text-purple-400" />
                Espectadores ({spectators.length})
              </h3>
            </div>

            {spectators.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-500 border border-dashed border-zinc-800/80 rounded-xl">
                Nenhum amigo conectado no momento.
                <br />
                Envie o link ou código da sala para começar.
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
                      <span className="font-mono text-zinc-200">
                        Amigo #{i + 1} ({spec.id.slice(0, 10)}...)
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500">P2P Direto</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dica Rápida */}
          <div className="p-3.5 rounded-2xl bg-[#0E1218]/50 border border-zinc-800/60 text-[11px] text-zinc-400 space-y-1">
            <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              Arquitetura P2P Segura
            </span>
            <p>
              O vídeo e áudio trafegam diretamente entre você e seus amigos via WebRTC criptografado de ponta a ponta, sem intermediários gravando seu feed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
