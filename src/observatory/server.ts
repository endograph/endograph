import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../harness/paths.ts";
import { ENDOGRAPH_ROOT } from "../harness/paths.ts";
import { readObservatorySnapshot } from "./data.ts";
import type { ObservatoryUi } from "./build.ts";

const ASSET_DIR = import.meta.dir;

export interface ObservatoryServer {
  url: string;
  port: number;
  stop(): void;
}

export function serveObservatory(options: { paths: Paths; name?: string; port?: number; ui: ObservatoryUi }): ObservatoryServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4319,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (url.pathname === "/api/snapshot") {
        try {
          return Response.json(await readObservatorySnapshot(options.paths, options.name));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }
      if (url.pathname === "/observatory.css") return asset("observatory.css", "text/css; charset=utf-8");
      if (url.pathname === "/observatory.js") return new Response(options.ui.script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/favicon.svg") return new Response(readFileSync(join(ENDOGRAPH_ROOT, "favicon.svg")), { headers: { "content-type": "image/svg+xml" } });
      if (url.pathname === "/" || url.pathname === "/index.html") return asset("index.html", "text/html; charset=utf-8");
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port ?? options.port ?? 4319}`,
    port: server.port ?? options.port ?? 4319,
    stop: () => server.stop(true),
  };
}

function asset(name: string, contentType: string): Response {
  return new Response(readFileSync(join(ASSET_DIR, name)), {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
