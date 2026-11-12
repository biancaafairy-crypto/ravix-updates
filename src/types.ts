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
  resolutionMode: string; // "native" | "1080p" | "1440p" | "custom"
  customWidth?: number | null;
  customHeight?: number | null;
  framingMode: string; // "stretch" | "fit" | "fill_crop"
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
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  framingMode: string;
}

export interface RecordedFileInfo {
  path: string;
  filename: string;
  sizeBytes: number;
  modifiedTs: number;
}

export interface VideoMetadata {
  path: string;
  filename: string;
  width: number;
  height: number;
  durationSecs: number;
  fps: number;
  bitrateKbps: number;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  audioSampleRate: number;
  sizeBytes: number;
}

export interface ExportConfig {
  inputPath: string;
  outputPath: string;
  resolutionMode: string; // "original" | "1080p" | "1440p" | "custom"
  customWidth?: number | null;
  customHeight?: number | null;
  framingMode: string; // "stretch" | "fit" | "fill_crop"
  fps: number;
  bitrateKbps: number;
}

export interface ExportProgress {
  state: "idle" | "exporting" | "done" | "error" | "cancelled";
  progressPct: number;
  elapsedSecs: number;
  currentFps: number;
  outputPath?: string | null;
  error?: string | null;
}
