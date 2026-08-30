import type { Frame, FrameInput, FrameStore, Snapshot } from "./types.ts";

/** In-memory backend; exists to prove the seam and to back tests. */
export function openMemoryStore(): FrameStore {
  const frames: Frame[] = [];
  let snapshot: Snapshot | null = null;

  return {
    append(frame: FrameInput): Frame {
      const appended = { ...frame, seq: frames.length + 1 };
      frames.push(appended);
      return appended;
    },
    read(fromSeq: number, limit = 1000): Frame[] {
      return frames.filter((f) => f.seq > fromSeq).slice(0, limit);
    },
    lastSeq(): number {
      return frames.length;
    },
    writeSnapshot(s: Snapshot): void {
      snapshot = s;
    },
    readSnapshot(): Snapshot | null {
      return snapshot;
    },
    close(): void {},
  };
}
