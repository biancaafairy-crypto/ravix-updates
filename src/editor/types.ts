export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  kind: "video" | "audio";
  durationSecs: number;
  width: number;
  height: number;
  fps: number;
  audioChannels: number;
  audioSampleRate: number;
  sizeBytes: number;
}

export interface TimelineClip {
  id: string;
  assetId: string;
  sourcePath: string;
  name: string;
  timelineStartSecs: number;
  inPointSecs: number;
  outPointSecs: number;
  durationSecs: number;
  volume: number; // 0.0 a 2.0 (1.0 = normal)
  isMuted: boolean;
  scale?: number; // 0.5 a 2.0 (1.0 = 100%)
  scaleX?: number; // 0.5 a 2.0 (1.0 = 100%)
  scaleY?: number; // 0.5 a 2.0 (1.0 = 100%)
  positionX?: number; // -50 a 50 (%)
  positionY?: number; // -50 a 50 (%)
  cropLeft?: number; // 0 a 50 (%)
  cropRight?: number; // 0 a 50 (%)
  cropTop?: number; // 0 a 50 (%)
  cropBottom?: number; // 0 a 50 (%)
  framingMode?: "stretch" | "fit" | "fill_crop";
}

export interface TimelineAudioTrack {
  id: string;
  assetId: string;
  sourcePath: string;
  name: string;
  timelineStartSecs: number;
  inPointSecs: number;
  durationSecs: number;
  volume: number; // 0.0 a 2.0
  isMuted: boolean;
  fadeInSecs: number;
  fadeOutSecs: number;
}

export interface RavixProject {
  version: string;
  name: string;
  assets: MediaAsset[];
  videoClips: TimelineClip[];
  musicTracks: TimelineAudioTrack[];
  framingMode: "fit" | "stretch" | "fill_crop";
  resolutionMode: "1080p" | "720p" | "1440p" | "4k" | "native" | "custom";
  fps: number;
  bitrateKbps: number;
}

export interface ExportDestinationCheck {
  isValid: boolean;
  exists: boolean;
  canWrite: boolean;
  message?: string | null;
}

export interface TimelineExportConfig {
  outputPath: string;
  resolutionMode: string;
  customWidth?: number;
  customHeight?: number;
  framingMode: string;
  fps: number;
  bitrateKbps: number;
  clips: {
    id: string;
    sourcePath: string;
    inPointSecs: number;
    outPointSecs: number;
    volume: number;
    isMuted: boolean;
    scale?: number;
    scaleX?: number;
    scaleY?: number;
    positionX?: number;
    positionY?: number;
    cropLeft?: number;
    cropRight?: number;
    cropTop?: number;
    cropBottom?: number;
  }[];
  musicTracks: {
    id: string;
    sourcePath: string;
    startTimelineSecs: number;
    inPointSecs: number;
    durationSecs: number;
    volume: number;
    isMuted: boolean;
    fadeInSecs: number;
    fadeOutSecs: number;
  }[];
}
