import { useState, useCallback } from "react";
import type { TimelineClip, TimelineAudioTrack } from "./types";

export interface ProjectSnapshot {
  videoClips: TimelineClip[];
  musicTracks: TimelineAudioTrack[];
}

export function useTimelineHistory(initialSnapshot: ProjectSnapshot) {
  const [past, setPast] = useState<ProjectSnapshot[]>([]);
  const [present, setPresent] = useState<ProjectSnapshot>(initialSnapshot);
  const [future, setFuture] = useState<ProjectSnapshot[]>([]);

  const pushState = useCallback((newSnapshot: ProjectSnapshot) => {
    setPast((prev) => [...prev.slice(-30), present]);
    setPresent(newSnapshot);
    setFuture([]);
  }, [present]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);
    setFuture((prev) => [present, ...prev]);
    setPresent(previous);
    setPast(newPast);
  }, [past, present]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    const newFuture = future.slice(1);
    setPast((prev) => [...prev, present]);
    setPresent(next);
    setFuture(newFuture);
  }, [future, present]);

  const reset = useCallback((snapshot: ProjectSnapshot) => {
    setPast([]);
    setPresent(snapshot);
    setFuture([]);
  }, []);

  return {
    state: present,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    pushState,
    undo,
    redo,
    reset,
  };
}
