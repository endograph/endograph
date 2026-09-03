import { allFrames, type Frame, type FrameStore } from "./types.ts";

/**
 * Read-side queries over the frame log. They never need the declaration:
 * everything a reader needs is in the store.
 */

/** The latest value of a projected state, from the last state.update that touched it. */
export function latestState<T>(store: FrameStore, key: string): T | undefined {
  let value: T | undefined;
  for (const frame of allFrames(store)) {
    const messages = (frame.payload as { messages?: unknown[] } | undefined)?.messages ?? [];
    for (const m of messages as Record<string, unknown>[]) {
      if (m.type === "instance" && m.kind === "state.update" && m.stateKey === key) {
        const update = m.update as { value?: T } | undefined;
        if (update && typeof update === "object" && "value" in update) value = update.value;
      }
    }
  }
  return value;
}

/** Requests and calls that have no reply frame yet. */
export function openIncidents(store: FrameStore): Frame[] {
  const open = new Map<string, Frame>();
  for (const frame of allFrames(store)) {
    if ((frame.type === "request" || frame.type === "call") && frame.incident) open.set(frame.incident, frame);
    if (frame.type === "reply" && frame.incident) open.delete(frame.incident);
  }
  return [...open.values()];
}

export function recentFrames(store: FrameStore, limit: number): Frame[] {
  return store.read(Math.max(0, store.lastSeq() - limit), limit);
}

export function framesAbout(store: FrameStore, thing: string, limit = 40): Frame[] {
  const needle = thing.toLowerCase();
  const hits: Frame[] = [];
  for (const frame of allFrames(store)) {
    if (frame.incident?.toLowerCase() === needle || frame.subject?.toLowerCase().includes(needle) || frame.summary.toLowerCase().includes(needle)) {
      hits.push(frame);
    }
  }
  return hits.slice(-limit);
}

export function framesOfIncident(store: FrameStore, incident: string): Frame[] {
  const hits: Frame[] = [];
  for (const frame of allFrames(store)) if (frame.incident === incident) hits.push(frame);
  return hits;
}
