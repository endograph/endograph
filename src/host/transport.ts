export const DEFAULT_MAX_BYTES = 1024 * 1024;
/** Dedicated, trusted-parent-bound connection. Messages are complete JSON strings, without newlines. */
export interface HostTransport {
  send(message: string): void;
  subscribe(message: (message: string) => void, closed: (error?: Error) => void): () => void;
  close(): void;
}

interface IpcEndpoint {
  send?: (message: string, callback: (error: Error | null) => void) => unknown;
  connected?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  disconnect?(): void;
}

/** Node/Bun's private inherited IPC channel, with native descriptor ownership. */
export function ipcTransport(endpoint: IpcEndpoint): HostTransport {
  let ended = false;
  let onClose: ((error?: Error) => void) | undefined;
  const close = (error?: Error) => {
    if (ended) return;
    ended = true;
    onClose?.(error);
    if (endpoint.connected) endpoint.disconnect?.();
  };
  return {
    send(message) {
      if (ended || !endpoint.send || endpoint.connected === false) throw new Error("host connection closed");
      endpoint.send(message, (error) => { if (error) close(error); });
    },
    subscribe(onMessage, closed) {
      onClose = closed;
      const message = (value: unknown) => onMessage(typeof value === "string" ? value : "");
      const disconnected = () => close(new Error("host connection closed"));
      endpoint.on("message", message);
      endpoint.on("disconnect", disconnected);
      if (ended || endpoint.connected === false) queueMicrotask(disconnected);
      return () => { endpoint.off("message", message); endpoint.off("disconnect", disconnected); onClose = undefined; };
    },
    close: () => close(new Error("host connection closed")),
  };
}
