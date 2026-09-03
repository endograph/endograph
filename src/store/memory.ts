import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";

/** In-memory backend: proves the seam, backs tests. */
export function openMemoryStore(): FrameStore {
  const frames: Frame[] = [];
  let snapshot: Snapshot | null = null;
  return {
    append(frame) {
      const appended = { ...frame, seq: frames.length + 1 };
      frames.push(appended);
      return appended;
    },
    read(fromSeq, limit = 1000) {
      return frames.filter((f) => f.seq > fromSeq).slice(0, limit);
    },
    lastSeq: () => frames.length,
    writeSnapshot(s) {
      snapshot = s;
    },
    readSnapshot: () => snapshot,
    close() {},
  };
}
