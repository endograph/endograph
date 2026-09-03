/**
 * The storage seam — deliberately tiny: append frames, read from a
 * sequence number, write/read a snapshot. No backend capability
 * (reactivity, pubsub) may leak into this interface. One agent per store.
 */

export interface FrameInput {
  /** Frame class: "drift", "action", "outcome", "activation", "note", ... */
  type: string;
  /** World-model entry or topic the frame concerns, if any. */
  subject?: string;
  /** One-line human-readable account. */
  summary: string;
  /** Structured payload; JSON-serializable. */
  payload?: unknown;
  /** Groups frames into an incident for `endo replay`. */
  incident?: string;
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
  append(frame: FrameInput): Frame;
  /** Frames with seq > fromSeq, ascending, up to limit. */
  read(fromSeq: number, limit?: number): Frame[];
  lastSeq(): number;
  writeSnapshot(snapshot: Snapshot): void;
  readSnapshot(): Snapshot | null;
  close(): void;
}

/** Walk the log from a seq (exclusive) in batches. */
export function* allFrames(store: FrameStore, batch = 1000, fromSeq = 0): Generator<Frame> {
  let from = fromSeq;
  for (;;) {
    const frames = store.read(from, batch);
    if (frames.length === 0) return;
    yield* frames;
    from = frames[frames.length - 1]!.seq;
  }
}
