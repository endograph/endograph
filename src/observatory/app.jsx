import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSeq, setSelectedSeq] = useState(null);
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("frame");
  const lastSeq = useRef(null);

  useEffect(() => {
    let stopped = false;
    let timer;
    const refresh = async () => {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
        if (stopped) return;
        const latest = value.log.frames.at(-1)?.seq ?? null;
        setSelectedSeq((current) => current === null || current === lastSeq.current ? latest : current);
        lastSeq.current = latest;
        setSnapshot(value);
        setError(null);
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!stopped) timer = setTimeout(refresh, 1500);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (snapshot?.agent.name) document.title = `${snapshot.agent.name} · Endograph Observatory`;
  }, [snapshot?.agent.name]);

  const frames = useMemo(
    () => (snapshot?.log.frames ?? []).filter((frame) => matchesFilter(frame, filter)).reverse(),
    [snapshot, filter],
  );
  const selected = snapshot?.log.frames.find((frame) => frame.seq === selectedSeq);

  return (
    <div className="app">
      <Topbar snapshot={snapshot} error={error} />
      <main className="workspace">
        <section className="activity" aria-labelledby="activity-title">
          <ActivityHeader snapshot={snapshot} />
          <FrameFilters filter={filter} onChange={setFilter} snapshot={snapshot} />
          <div className="frame-list" aria-live="polite">
            {frames.length ? frames.map((frame) => (
              <FrameRow
                key={frame.seq}
                frame={frame}
                selected={frame.seq === selectedSeq}
                onSelect={() => {
                  setSelectedSeq(frame.seq);
                  setTab("frame");
                }}
              />
            )) : (
              <p className="empty">{snapshot?.log.frames.length ? "No frames match this view." : "No frames yet. The first inception or request will appear here."}</p>
            )}
          </div>
        </section>
        <Inspector tab={tab} onTab={setTab} snapshot={snapshot} frame={selected} />
      </main>
    </div>
  );
}

function Topbar({ snapshot, error }) {
  const mode = error ? "down" : (snapshot?.agent.phase ?? "down");
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark">endo</span><span className="slash">/</span><span>observatory</span></div>
      <div className="agent-context">
        <span className="status-dot" data-state={mode} />
        <strong>{snapshot?.agent.name ?? "agent"}</strong>
        <span className="agent-state" title={snapshot?.agent.reason ?? undefined}>{error ? "disconnected" : mode === "active" ? "working" : mode}</span>
      </div>
      <time>{error ?? (snapshot ? `updated ${time(snapshot.generatedAt)}` : "connecting…")}</time>
    </header>
  );
}

function ActivityHeader({ snapshot }) {
  const counts = countTypes(snapshot?.log.frames ?? []);
  return (
    <div className="section-head">
      <div>
        <p className="eyebrow">projector · frame log</p>
        <h1 id="activity-title">What the machine is doing</h1>
      </div>
      <dl className="metrics">
        <Metric label="frames" value={snapshot?.log.total ?? 0} />
        <Metric label="activations" value={counts.activation ?? 0} />
        <Metric label="inceptions" value={snapshot?.inception.history.length ?? 0} />
      </dl>
    </div>
  );
}

function Metric({ label, value }) {
  return <div className="metric"><dt>{label}</dt><dd>{value}</dd></div>;
}

const FILTERS = [
  ["all", "all"],
  ["conversation", "requests"],
  ["work", "work"],
  ["problems", "problems"],
];

function FrameFilters({ filter, onChange, snapshot }) {
  return (
    <div className="filters" role="toolbar" aria-label="Filter frames">
      {FILTERS.map(([value, label]) => (
        <button key={value} type="button" data-active={filter === value ? "" : undefined} onClick={() => onChange(value)}>{label}</button>
      ))}
      <span className="frame-window">{snapshot?.log.truncated ? `latest ${snapshot.log.frames.length}` : `${snapshot?.log.frames.length ?? 0} total`}</span>
    </div>
  );
}

function FrameRow({ frame, selected, onSelect }) {
  return (
    <button
      type="button"
      className="frame-row"
      data-selected={selected ? "" : undefined}
      aria-label={`Inspect frame ${frame.seq}: ${frame.summary}`}
      onClick={onSelect}
    >
      <span className="frame-seq">{pad(frame.seq)}</span>
      <time className="frame-time">{time(frame.at)}</time>
      <span className="frame-kind" data-tone={toneOf(frame)}>{frame.type}</span>
      <span className="frame-summary">{frame.summary}</span>
    </button>
  );
}

function Inspector({ tab, onTab, snapshot, frame }) {
  return (
    <aside className="inspector" aria-label="Machine inspector">
      <nav className="tabs" aria-label="Inspector views">
        {["frame", "state", "inception"].map((name) => (
          <button key={name} type="button" data-active={tab === name ? "" : undefined} onClick={() => onTab(name)}>{name}</button>
        ))}
      </nav>
      <div className="inspector-body">
        {tab === "frame" ? <FrameDetail frame={frame} /> : tab === "state" ? <MachineState machine={snapshot?.machine} /> : <InceptionPane inception={snapshot?.inception} />}
      </div>
    </aside>
  );
}

function FrameDetail({ frame }) {
  if (!frame) return <p className="empty">Select a frame to see what projector observed and produced.</p>;
  const messages = messagesOf(frame);
  const execution = frame.payload?.provenance?.execution;
  return (
    <>
      <header className="detail-head">
        <p className="detail-kicker"><span>frame {pad(frame.seq)}</span><Chip tone={toneOf(frame)}>{frame.type}</Chip></p>
        <h2>{frame.summary}</h2>
        <p className="detail-meta"><time>{fullTime(frame.at)}</time>{frame.id && <span>request {frame.id}</span>}</p>
      </header>
      {messages.length ? (
        <div className="message-list">{messages.map((message, index) => <FrameMessage key={index} message={message} />)}</div>
      ) : frame.payload?.text && frame.type === "reply" ? (
        <div className="message-list"><FrameMessage message={{ type: "reply", text: frame.payload.text, success: frame.payload.ok }} /></div>
      ) : frame.payload?.error && frame.type === "error" ? (
        <div className="message-list"><FrameMessage message={{ type: "error", text: frame.payload.error }} /></div>
      ) : frame.type === "inception" ? (
        <div className="message-list"><FrameMessage message={{ type: "inception", text: frame.payload?.changes || "A new program and machine snapshot were recorded." }} /></div>
      ) : <p className="empty">This is an envelope frame; it carries no projector messages.</p>}
      {execution && (
        <div className="provenance">
          {execution.model && <Fact label="model" value={execution.model} />}
          {execution.latencyMs !== undefined && <Fact label="latency" value={duration(execution.latencyMs)} />}
          {execution.usage?.inputTokens !== undefined && <Fact label="input" value={`${execution.usage.inputTokens.toLocaleString()} tokens`} />}
          {execution.usage?.outputTokens !== undefined && <Fact label="output" value={`${execution.usage.outputTokens.toLocaleString()} tokens`} />}
        </div>
      )}
      {frame.payload !== undefined && <JsonDisclosure title="raw frame" value={frame.payload} />}
    </>
  );
}

function FrameMessage({ message }) {
  const value = describeMessage(message);
  return (
    <article className="message" data-tone={value.tone}>
      <span className="message-role">{value.role}</span>
      <pre className="message-body">{value.body}</pre>
    </article>
  );
}

function MachineState({ machine }) {
  if (!machine) return <p className="empty">No machine snapshot yet. A snapshot is written at inception and after each activation.</p>;
  return (
    <>
      <div className="state-summary"><span>as of frame {pad(machine.asOfSeq)}</span><time>{fullTime(machine.at)}</time></div>
      {machine.instance && typeof machine.instance === "object" ? <InstanceNode instance={machine.instance} source /> : <JsonDisclosure title="raw state" value={machine.instance} open />}
    </>
  );
}

// Adapted from projector's sandbox InstanceNode/StateList idiom: the runtime
// is a disclosure tree, state keys are first-class, and raw JSON is always one
// click away. Endograph's snapshot is serialized rather than client-projected.
function InstanceNode({ instance, source = false }) {
  const [expanded, setExpanded] = useState(true);
  const states = instance.states && typeof instance.states === "object" ? Object.entries(instance.states) : [];
  const children = Array.isArray(instance.children) ? instance.children : [];
  const label = nodeName(instance.node) || instance.id || "instance";
  return (
    <section className="instance">
      <button type="button" className="instance-head" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="disclosure-mark">{expanded ? "−" : "+"}</span>
        <strong>{label}</strong>
        {(source || instance.isSource) && <Chip tone="actor">source</Chip>}
        {instance.id && instance.id !== label && <span className="detail-kicker">{instance.id}</span>}
        <span className="instance-count">{states.length} state / {children.length} child</span>
      </button>
      {expanded && <div className="instance-content">
        {states.length ? <StateList states={states} /> : !children.length && <p className="state-note">No materialized state values. Projector is carrying the node’s inception defaults.</p>}
        {children.length > 0 && <div className="instance-children">{children.map((child, index) => <InstanceNode key={child.id ?? index} instance={child} />)}</div>}
      </div>}
    </section>
  );
}

function StateList({ states }) {
  return <div>{states.map(([key, container]) => <StateTreeItem key={key} name={key} value={container && typeof container === "object" && "value" in container ? container.value : container} />)}</div>;
}

function StateTreeItem({ name, value }) {
  const complex = value !== null && typeof value === "object";
  return (
    <div className="state-row">
      <span className="state-key">{name}</span>
      {complex ? <ValueTree value={value} /> : <span className="value">{scalar(value)}</span>}
    </div>
  );
}

function ValueTree({ value, depth = 0 }) {
  if (value === null || typeof value !== "object") return <span className="value">{scalar(value)}</span>;
  const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
  if (JSON.stringify(value).length < 72) return <span className="value">{JSON.stringify(value)}</span>;
  return (
    <details className="state-branch" open={depth === 0 && entries.length <= 8}>
      <summary>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</summary>
      <div className="instance-children">{entries.map(([key, child]) => <div className="state-row" key={key}><span className="value-key">{key}</span><ValueTree value={child} depth={depth + 1} /></div>)}</div>
    </details>
  );
}

function InceptionPane({ inception }) {
  if (!inception?.history.length && !inception?.attempts.length) return <p className="empty">No inception has been recorded yet. The first one will show its program and snapshot here.</p>;
  const recorded = new Map(inception.history.map((item) => [item.n, item]));
  const unrecorded = inception.attempts.filter((attempt) => !recorded.has(attempt.n)).map((attempt) => ({
    n: attempt.n,
    at: Date.parse(attempt.started || "") || 0,
    attempt,
    inputsChanged: [],
    resultChanged: [],
    files: [],
    shape: { nodes: [], states: [], procedures: [] },
    artifacts: {},
  }));
  const entries = [...inception.history, ...unrecorded].sort((a, b) => b.n - a.n);
  const healthy = !inception.changed.length && !inception.programEdited && !inception.loadError && !inception.inputError;
  const drift = [inception.changed.length ? `changed: ${inception.changed.join(", ")}` : "", inception.programEdited ? "program edited by hand" : "", inception.loadError || inception.inputError || ""].filter(Boolean).join(" · ");
  return (
    <>
      <div className="drift">
        <strong>{healthy ? `Inception ${inception.latest} matches the owner’s inputs` : `Inception ${inception.latest} is no longer current`}</strong>
        <p>{healthy ? "The manifest, grant, endograph version, and recorded program are aligned." : drift}</p>
      </div>
      <div className="inception-timeline">{entries.map((item, index) => <InceptionCard key={`${item.n}:${item.attempt?.outcome ?? "recorded"}`} item={item} current={index === 0} />)}</div>
    </>
  );
}

function InceptionCard({ item, current }) {
  const rounds = item.rounds ?? item.attempt?.rounds ?? item.attempt?.details.length ?? 0;
  const shape = [
    item.shape.nodes.length ? `${item.shape.nodes.length} node${item.shape.nodes.length === 1 ? "" : "s"}: ${item.shape.nodes.join(", ")}` : "",
    item.shape.states.length ? `${item.shape.states.length} state${item.shape.states.length === 1 ? "" : "s"}: ${item.shape.states.join(", ")}` : "",
    item.shape.procedures.length ? `${item.shape.procedures.length} procedure${item.shape.procedures.length === 1 ? "" : "s"}: ${item.shape.procedures.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <article className="inception-card" data-current={current ? "" : undefined} data-failed={item.attempt?.outcome === "failed" ? "" : undefined}>
      <div className="inception-top"><h2>Inception {item.n}</h2><time>{item.at ? date(item.at) : "in progress"}</time></div>
      <div className="inception-facts">
        <Chip tone={rounds > 1 ? "state" : "ok"}>{rounds} round{rounds === 1 ? "" : "s"}</Chip>
        <Chip tone="actor">{item.inceptor || item.attempt?.inceptor || "unknown inceptor"}</Chip>
        {item.version && <Chip>endograph {item.version}</Chip>}
        {item.ms !== undefined && <Chip>{duration(item.ms)}</Chip>}
        {item.attempt?.outcome === "failed" && <Chip tone="bad">failed</Chip>}
        {item.attempt?.outcome === "in-progress" && <Chip tone="state">in progress</Chip>}
        {item.inputsChanged.map((input) => <Chip key={input} tone="state">{input} {item.n === 1 ? "seeded" : "changed"}</Chip>)}
      </div>
      <p className="shape">{shape || (item.attempt?.outcome === "failed" ? "No program was recorded from this attempt." : `${item.files.length} files captured`)}</p>
      <pre className="brief">{item.changes || item.attempt?.error || (item.n === 1 ? "Initial program and machine shape created from the owner’s manifest." : "No inceptor brief was recorded.")}</pre>
      {item.attempt?.details.length > 0 && <InceptionAttempt attempt={item.attempt} />}
      {item.resultChanged.length > 0 && <FileChanges changes={item.resultChanged} />}
      {Object.values(item.artifacts).some(Boolean) && <ArtifactViewer artifacts={item.artifacts} />}
    </article>
  );
}

function InceptionAttempt({ attempt }) {
  return (
    <details className="attempt">
      <summary>how inception ran · {attempt.details.length} round{attempt.details.length === 1 ? "" : "s"}</summary>
      <div className="round-list">{attempt.details.map((round) => <Round key={round.round} round={round} />)}</div>
    </details>
  );
}

function Round({ round }) {
  const timings = [round.inceptorMs !== undefined ? `inceptor ${duration(round.inceptorMs)}` : "", round.validateMs !== undefined ? `validation ${duration(round.validateMs)}` : "", round.exitCode !== undefined ? `exit ${round.exitCode}` : ""].filter(Boolean).join(" · ");
  return (
    <article className="round-row">
      <div className="round-head"><strong>round {round.round}</strong><Chip tone={round.passed ? "ok" : "bad"}>{round.passed ? "passed" : `failed${round.stage ? ` · ${round.stage}` : ""}`}</Chip>{timings && <span className="round-time">{timings}</span>}</div>
      {[['validation', round.errors], ['stdout', round.stdout], ['stderr', round.stderr]].filter(([, value]) => value).map(([label, value]) => <details className="round-output" key={label}><summary>{label}</summary><pre>{value}</pre></details>)}
    </article>
  );
}

function FileChanges({ changes }) {
  return (
    <div className="file-changes">
      {changes.slice(0, 12).map((file) => <div className="file-change" data-kind={file.kind} key={`${file.kind}:${file.path}`}><span>{file.kind === "added" ? "+" : file.kind === "removed" ? "−" : "~"}</span><span>{file.path}</span></div>)}
      {changes.length > 12 && <span className="detail-kicker">+ {changes.length - 12} more</span>}
    </div>
  );
}

function ArtifactViewer({ artifacts }) {
  const available = Object.entries(artifacts).filter(([, value]) => value);
  const [active, setActive] = useState(available[0]?.[0]);
  return (
    <details className="artifact">
      <summary>inspect inception artifacts</summary>
      <div className="mini-tabs">{available.map(([name]) => <button type="button" key={name} data-active={active === name ? "" : undefined} onClick={() => setActive(name)}>{name}</button>)}</div>
      <pre>{artifacts[active]}</pre>
    </details>
  );
}

function JsonDisclosure({ title, value, open = false }) {
  return <details className="raw" open={open}><summary>{title}</summary><pre className="raw-json">{pretty(value)}</pre></details>;
}

function Chip({ children, tone = "plain" }) {
  return <span className="chip" data-tone={tone}>{children}</span>;
}

function Fact({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function matchesFilter(frame, filter) {
  if (filter === "all") return true;
  if (filter === "conversation") return ["request", "reply", "call"].includes(frame.type);
  if (filter === "work") return ["activation", "completion", "action", "instance", "compaction", "procedure"].includes(frame.type);
  return frame.type === "error" || /fail|error|abort|reject/i.test(frame.summary) || messagesOf(frame).some((message) => message.success === false || message.kind === "abort");
}

function toneOf(frame) {
  if (frame.type === "request" || frame.type === "activation") return "actor";
  if (frame.type === "instance" || frame.type === "compaction" || frame.type === "inception") return "state";
  if (frame.type === "reply" || frame.type === "completion") return /fail|reject|abort|error/i.test(frame.summary) ? "bad" : "ok";
  if (frame.type === "error" || /fail|error|abort|reject/i.test(frame.summary)) return "bad";
  return "plain";
}

function describeMessage(message) {
  if (message.type === "user") return { role: message.actor?.label || "request", body: message.text || "", tone: "actor" };
  if (message.type === "assistant") return { role: "projector", body: message.text || textContent(message.content), tone: "actor" };
  if (message.type === "action" && message.kind === "request") return { role: `→ ${message.name || message.action || "action"}`, body: pretty(message.input), tone: "state" };
  if (message.type === "action" && message.kind === "result") return { role: `← ${message.name || message.action || "action"} ${message.success ? "ok" : "failed"}`, body: pretty(message.success ? message.value : message.error), tone: message.success ? "ok" : "bad" };
  if (message.type === "work" && message.kind === "activation") return { role: "activation", body: `${message.generatorId || "generator"}\nsource ${message.sourceFrameId || "unknown"}`, tone: "actor" };
  if (message.type === "work" && message.kind === "completion") return { role: "completion", body: message.reason || "complete", tone: "ok" };
  if (message.type === "work" && message.kind === "abort") return { role: "abort", body: message.note || "aborted", tone: "bad" };
  if (message.type === "instance") return { role: `state · ${message.kind || "update"}`, body: pretty(message), tone: "state" };
  if (message.type === "horizon") return { role: "history horizon", body: pretty(message), tone: "state" };
  if (message.type === "reply") return { role: message.success === false ? "reply · failed" : "reply", body: message.text || "", tone: message.success === false ? "bad" : "ok" };
  if (message.type === "error") return { role: "error", body: message.text || "", tone: "bad" };
  if (message.type === "inception") return { role: "inceptor brief", body: message.text || "", tone: "state" };
  return { role: `${message.type || "message"}${message.kind ? ` · ${message.kind}` : ""}`, body: pretty(message), tone: "plain" };
}

function messagesOf(frame) { return Array.isArray(frame.payload?.messages) ? frame.payload.messages : []; }
function countTypes(frames) { return frames.reduce((counts, frame) => ({ ...counts, [frame.type]: (counts[frame.type] || 0) + 1 }), {}); }
function pretty(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function scalar(value) { return value === null || value === undefined ? "null" : String(value); }
function textContent(content) { return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : ""; }
function nodeName(node) { return typeof node === "string" ? node : node?.key; }
function pad(seq) { return String(seq).padStart(4, "0"); }
function time(at) { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function date(at) { return new Date(at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); }
function fullTime(at) { return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }); }
function duration(ms) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`; }

createRoot(document.getElementById("root")).render(<App />);
