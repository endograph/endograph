/**
 * The pluggable storage seam — deliberately tiny. Append frames, read frames
 * from a sequence number, write/read snapshot. No backend capability
 * (reactivity, pubsub) may leak into this interface.
 *
 * One durable agent identity per database.
 */

export interface FrameInput {
  /** Frame class, e.g. "drift", "action", "outcome", "activation", "note". */
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
  /** Opaque serialized world model; the store never interprets it. */
  state: unknown;
}

export interface FrameStore {
  append(frame: FrameInput): Frame;
  /** Read frames with seq > fromSeq, ascending, up to limit. */
  read(fromSeq: number, limit?: number): Frame[];
  lastSeq(): number;
  writeSnapshot(snapshot: Snapshot): void;
  readSnapshot(): Snapshot | null;
  close(): void;
}
