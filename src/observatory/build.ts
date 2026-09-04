import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UI_PACKAGES = { react: "19.2.3", "react-dom": "19.2.3" } as const;

export interface ObservatoryUi {
  script: string;
}

/**
 * React is tooling for the observatory, not part of an embedded agent. Keep
 * it in Endograph's user cache and bundle it into one browser asset on launch.
 * The first run installs two pinned packages; later runs only do the fast Bun
 * bundle so edits to the built-in inspector are immediately visible.
 */
export async function prepareObservatoryUi(
  log: (line: string) => void = () => {},
  cache = observatoryUiCache(),
): Promise<ObservatoryUi> {
  mkdirSync(cache, { recursive: true });
  if (!uiDependenciesReady(cache)) {
    writeFileSync(
      join(cache, "package.json"),
      `${JSON.stringify({ private: true, dependencies: UI_PACKAGES }, null, 2)}\n`,
    );
    log("installing the observatory UI (first run only)…");
    const child = Bun.spawn([process.execPath, "install", "--production", "--ignore-scripts", "--no-progress"], {
      cwd: cache,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const detail = `${stdout}\n${stderr}`.trim();
      throw new Error(`could not install the observatory UI${detail ? `:\n${detail}` : ""}`);
    }
  }

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "app.jsx")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [reactFrom(cache)],
  });
  if (!result.success) {
    throw new Error(`could not build the observatory UI:\n${result.logs.map(String).join("\n")}`);
  }
  const output = result.outputs.find((artifact) => artifact.kind === "entry-point") ?? result.outputs[0];
  if (!output) throw new Error("the observatory UI build produced no browser script");
  return { script: await output.text() };
}

export function observatoryUiCache(): string {
  const home = process.env.ENDOGRAPH_HOME ?? join(homedir(), ".endograph");
  return join(home, "observatory", `react-${UI_PACKAGES.react}`);
}

export function uiDependenciesReady(cache = observatoryUiCache()): boolean {
  return Object.entries(UI_PACKAGES).every(([name, version]) => {
    try {
      const manifest = JSON.parse(readFileSync(join(cache, "node_modules", name, "package.json"), "utf8")) as { version?: string };
      return manifest.version === version;
    } catch {
      return false;
    }
  });
}

function reactFrom(cache: string): Bun.BunPlugin {
  return {
    name: "observatory-react-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => ({
        path: Bun.resolveSync(path, cache),
      }));
    },
  };
}
