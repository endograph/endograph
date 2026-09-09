import { EventEmitter } from "node:events";
import { ipcTransport } from "../../src/host/transport.ts";

/** Fake native endpoints keep protocol tests deterministic; the transport is real. */
class Endpoint extends EventEmitter {
  connected = true;
  peer!: Endpoint;
  send(message: string, callback: (error: Error | null) => void) {
    queueMicrotask(() => {
      if (!this.connected) return callback(new Error("IPC disconnected"));
      this.peer.emit("message", message);
      callback(null);
    });
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = this.peer.connected = false;
    queueMicrotask(() => { this.emit("disconnect"); this.peer.emit("disconnect"); });
  }
}

export function ipcPair() {
  const parent = new Endpoint();
  const child = new Endpoint();
  parent.peer = child;
  child.peer = parent;
  return { server: ipcTransport(parent), client: ipcTransport(child) };
}
