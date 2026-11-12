export interface CaptureSource {
  id: string;
  kind: "window" | "monitor";
  title: string;
  processName: string;
  width: number;
  height: number;
  refreshHz: number;
  isGamePriority: boolean;
}

export interface EncoderOption {
  id: string;
  name: string;
  vendor: string;
  codec: string;
  isHardware: boolean;
}

export interface AudioDeviceOption {
  id: string;
  name: string;
  isDefault: boolean;
  kind: "render" | "capture";
}

export interface SystemCapabilities {
  sources: CaptureSource[];
  encoders: EncoderOption[];
  renderDevices: AudioDeviceOption[];
  captureDevices: AudioDeviceOption[];
  supportedFps: number[];
  defaultOutputDir: string;
}

export interface RecordingConfig {
  sourceKind: string;
  sourceId: string;
  outputDir: string;
  resolutionMode: string;
  fps: number;
  bitrateKbps: number;
  encoderId: string;
  systemAudioEnabled: boolean;
  systemAudioDeviceId: string | null;
  micEnabled: boolean;
  micDeviceId: string | null;
  durationLimitSecs: number | null;
  segmentMinutes: number | null;
  hotkey: string;
  minFreeDiskMb: number;
  minimizeToTrayOnClose: boolean;
}

export interface RecorderStatus {
  state: "idle" | "starting" | "recording" | "stopping" | "error";
  elapsedSecs: number;
  durationLimitSecs: number | null;
  currentFile: string | null;
  currentSegment: number;
  framesCaptured: number;
  framesWritten: number;
  framesDropped: number;
  encoderErrors: number;
  actualFps: number;
  targetFps: number;
  fpsWarning: string | null;
  cpuUsagePct: number;
  memoryMb: number;
  freeDiskGb: number;
  activeEncoderName: string | null;
  lastError: string | null;
}

export interface RecordedFileInfo {
  path: string;
  filename: string;
  sizeBytes: number;
  modifiedTs: number;
}
