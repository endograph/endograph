/**
 * The storage seam: append frames, read from a sequence number, and commit
 * instance checkpoints. Immutable filesystem commits are authoritative;
 * SQLite provides runtime transactions and query indexes. One agent per
 * store. A persistence failure is fatal to the caller: the log is the agent.
 */

/** The endograph envelope: mirrored into columns, and carried as `frame.metadata.endo` on machine frames. */
export interface FrameInput {
  /** "request", "call", "reply", "activation", "inception", "error", ... */
  type: string;
  /** One-line human-readable account. */
  summary: string;
  /** The request or call this frame is about, when there is exactly one. */
  id?: string;
  /** JSON-serializable. The full projector frame when there is one. */
  payload?: unknown;
  at: number;
}

export interface Frame extends FrameInput {
  /** Monotonic, gapless, assigned by the store on append. */
  seq: number;
}

export interface Snapshot {
  /** Seq of the last frame folded into this snapshot. */
  asOfSeq: number;
  at: number;
  /** Opaque serialized machine instance; the store never interprets it. */
  state: unknown;
}

export interface FrameStore {
  /** Synchronous writes: nested calls use savepoints, the outer commit archives frames and checkpoint together. Never perform external effects here. */
  transaction<T>(write: () => T): T;
  append(frame: FrameInput): Frame;
  /** Frames with seq > fromSeq, ascending, up to limit. */
  read(fromSeq: number, limit?: number): Frame[];
  lastSeq(): number;
  writeSnapshot(snapshot: Snapshot): void;
  readSnapshot(): Snapshot | null;
  close(): void;
}

/** Walk the log from a seq (exclusive) in batches. */
export function* allFrames(store: FrameStore, fromSeq = 0, batch = 1000): Generator<Frame> {
  let from = fromSeq;
  for (;;) {
    const frames = store.read(from, batch);
    if (frames.length === 0) return;
    yield* frames;
    from = frames[frames.length - 1]!.seq;
  }
}
