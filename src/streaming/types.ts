export type StreamMode = "idle" | "host" | "spectator";
export type StreamStatus = "idle" | "creating_room" | "room_ready" | "streaming" | "error";
export type SpectatorStatus = "idle" | "connecting" | "connected" | "streaming" | "ended" | "error";

export interface StreamTelemetry {
  width: number;
  height: number;
  fps: number;
  elapsedSecs: number;
  hasAudio: boolean;
  hasMic: boolean;
  bitrateEstimateKbps: number;
}

export interface SpectatorPeer {
  id: string;
  name?: string;
  connectedAt: number;
  latencyMs?: number;
}

export interface StreamRoomConfig {
  roomId: string;
  roomTitle: string;
  maxFps: number;
  enableMic: boolean;
}
