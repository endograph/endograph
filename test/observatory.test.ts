import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsOf } from "../src/harness/paths.ts";
import { prepareObservatoryUi, uiDependenciesReady } from "../src/observatory/build.ts";
import { readObservatorySnapshot } from "../src/observatory/data.ts";
import { serveObservatory, type ObservatoryServer } from "../src/observatory/server.ts";
import { openSqliteStore } from "../src/store/sqlite.ts";

const servers: ObservatoryServer[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop()));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "endo-observatory-"));
  const paths = pathsOf(dir);
  mkdirSync(join(paths.snapshots, "1", "src", "procedures"), { recursive: true });
  writeFileSync(join(dir, "endograph.toml"), 'name = "fixture"\nmanifest = "manifest.md"\n');
  writeFileSync(join(dir, "manifest.md"), "# Fixture\n");
  writeFileSync(join(paths.snapshots, "1", "manifest.md"), "# Fixture\n");
  writeFileSync(join(paths.snapshots, "1", "endograph.toml"), "grant\n");
  writeFileSync(join(paths.snapshots, "1", "agent.ts"), 'const memory = createState({ key: "memory" });\nconst root = createNode({ key: "root" });\n');
  writeFileSync(join(paths.snapshots, "1", "src", "procedures", "hello.ts"), "procedure\n");
  mkdirSync(join(paths.inceptions, "1", "rounds", "1"), { recursive: true });
  writeFileSync(join(paths.inceptions, "1", "inception.json"), JSON.stringify({ n: 1, version: "0.1.0", inceptor: "manual", started: "2026-09-03T12:00:00Z", finished: "2026-09-03T12:00:01Z", rounds: 1, outcome: "recorded" }));
  writeFileSync(join(paths.inceptions, "1", "rounds", "1", "round.json"), JSON.stringify({ round: 1, at: "2026-09-03T12:00:01Z", validateMs: 12, passed: true }));
  mkdirSync(paths.state, { recursive: true });

  const store = openSqliteStore(paths.db);
  store.append({
    type: "inception",
    summary: "inception 1 after 1 round",
    at: 100,
    payload: { n: 1, manifest: "manifest", grant: "grant", program: "program", version: "0.1.0", inceptor: "manual", rounds: 1, changes: "Made a small fixture." },
  });
  store.append({
    type: "request",
    summary: "local:test: say hello",
    id: "request-1",
    at: 200,
    payload: { id: "frame-1", messages: [{ type: "user", text: "say hello", actor: { id: "local:test", label: "local:test" } }] },
  });
  store.writeSnapshot({ asOfSeq: 2, at: 201, state: { id: "agent", node: "root", isSource: true, states: { memory: { value: { note: "hello" } } } } });
  store.close();
  return paths;
}

test("observatory presents frames, machine state, and inception artifacts", async () => {
  const paths = fixture();
  const snapshot = await readObservatorySnapshot(paths, "fixture");
  expect(snapshot.log.frames).toHaveLength(2);
  expect(snapshot.machine).toMatchObject({ asOfSeq: 2, instance: { node: "root" } });
  expect(snapshot.inception.history[0]).toMatchObject({
    n: 1,
    changes: "Made a small fixture.",
    shape: { nodes: ["root"], states: ["memory"], procedures: ["hello"] },
    attempt: { outcome: "recorded", details: [{ round: 1, validateMs: 12, passed: true }] },
  });
  expect(snapshot.inception.history[0]?.artifacts.program).toContain('key: "root"');
});

test("observatory server is localhost-only and serves the app and live API", async () => {
  const paths = fixture();
  const server = serveObservatory({ paths, name: "fixture", port: 0, ui: { script: "globalThis.__observatoryReactTest = true;" } });
  servers.push(server);
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const [page, script, api, missing] = await Promise.all([
    fetch(server.url),
    fetch(`${server.url}/observatory.js`),
    fetch(`${server.url}/api/snapshot`),
    fetch(`${server.url}/elsewhere`),
  ]);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Starting observatory");
  expect(await script.text()).toContain("__observatoryReactTest");
  expect(api.status).toBe(200);
  expect(await api.json()).toMatchObject({ agent: { name: "fixture" }, log: { total: 2 } });
  expect(missing.status).toBe(404);
});

test("observatory UI uses the pinned React runtime to produce one browser bundle", async () => {
  const cache = mkdtempSync(join(tmpdir(), "endo-observatory-ui-"));
  expect(uiDependenciesReady(cache)).toBe(false);
  for (const name of ["react", "react-dom"]) {
    const dir = join(cache, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "19.2.3" }));
  }
  writeFileSync(join(cache, "node_modules", "react", "index.js"), "export default { createElement() {} }; export const useEffect = () => {}; export const useMemo = () => {}; export const useRef = () => ({}); export const useState = () => [];\n");
  writeFileSync(join(cache, "node_modules", "react", "jsx-runtime.js"), "export const Fragment = Symbol(); export const jsx = () => ({}); export const jsxs = jsx;\n");
  writeFileSync(join(cache, "node_modules", "react-dom", "client.js"), "export const createRoot = () => ({ render() {} });\n");
  expect(uiDependenciesReady(cache)).toBe(true);
  const ui = await prepareObservatoryUi(() => {}, cache);
  expect(ui.script).toContain("What the machine is doing");
});
