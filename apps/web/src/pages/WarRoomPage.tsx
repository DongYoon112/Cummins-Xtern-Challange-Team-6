import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { API_BASE, apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

type RunStatus = "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "REJECTED" | "FAILED";

type WarRoomEventType = "AGENT_ALERT" | "DEBATE_RESULT" | "ROUTER_DECISION_REQUIRED" | "WORKFLOW_STATUS_UPDATE";

type WarRoomEvent = {
  id?: number;
  runId: string;
  workflowId: string;
  stepId?: string;
  type: WarRoomEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};

type WarRoomDecision = {
  id: string;
  runId: string;
  workflowId: string;
  routerStepId: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decision?: "approve" | "reject" | null;
  requestedAt: string;
  decidedAt?: string | null;
};

type WarRoomSnapshot = {
  run: { runId: string; workflowId: string; status: RunStatus; pauseRequested?: boolean } | null;
  events: WarRoomEvent[];
  runSteps: Array<Record<string, unknown>>;
  activeSteps: Array<Record<string, unknown>>;
  pendingDecisions: WarRoomDecision[];
};

type WarRoomInterpretation = {
  mockMode: boolean;
  provider: string;
  model: string;
  interpretation: {
    summary: string;
    rationale: string;
    confidence: number;
  };
};

function readString(value: unknown, fallback = "N/A") {
  return typeof value === "string" ? value : fallback;
}

function readConfidence(value: unknown, fallback = "n/a") {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return fallback;
}

function readRecommendation(value: unknown, fallback = "N/A") {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.decision === "string" && record.decision.trim()) {
      return record.decision;
    }
  }
  return fallback;
}

function readStepLabel(step: Record<string, unknown>) {
  const params = step.params;
  if (params && typeof params === "object" && typeof (params as Record<string, unknown>).label === "string") {
    const label = String((params as Record<string, unknown>).label).trim();
    if (label) {
      return label;
    }
  }
  if (typeof step.name === "string" && step.name.trim()) {
    return step.name.trim();
  }
  if (typeof step.stepId === "string" && step.stepId.trim()) {
    return step.stepId.trim();
  }
  if (typeof step.id === "string" && step.id.trim()) {
    return step.id.trim();
  }
  return "Step";
}

function mergeEvents(current: WarRoomEvent[], incoming: WarRoomEvent[]) {
  const map = new Map<string, WarRoomEvent>();
  for (const event of current) {
    map.set(`${event.id ?? "noid"}-${event.timestamp}-${event.type}-${event.stepId ?? ""}`, event);
  }
  for (const event of incoming) {
    map.set(`${event.id ?? "noid"}-${event.timestamp}-${event.type}-${event.stepId ?? ""}`, event);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function statusBadgeClass(status: RunStatus | null) {
  switch (status) {
    case "RUNNING":
      return "bg-emerald-100 text-emerald-900 border-emerald-300";
    case "WAITING_APPROVAL":
      return "bg-amber-100 text-amber-900 border-amber-300";
    case "COMPLETED":
      return "bg-cyan-100 text-cyan-900 border-cyan-300";
    case "FAILED":
    case "REJECTED":
      return "bg-rose-100 text-rose-900 border-rose-300";
    default:
      return "bg-slate-100 text-slate-900 border-slate-300";
  }
}

export function WarRoomPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const runId = searchParams.get("runId") ?? "";
  const [events, setEvents] = useState<WarRoomEvent[]>([]);
  const [runSteps, setRunSteps] = useState<Array<Record<string, unknown>>>([]);
  const [activeSteps, setActiveSteps] = useState<Array<Record<string, unknown>>>([]);
  const [pendingDecisions, setPendingDecisions] = useState<WarRoomDecision[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportText, setReportText] = useState("");
  const [isControllingRun, setIsControllingRun] = useState(false);
  const [interpreterFocus, setInterpreterFocus] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [interpreterError, setInterpreterError] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<WarRoomInterpretation | null>(null);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }

    apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token)
      .then((snapshot) => {
        setEvents(snapshot.events ?? []);
        setRunSteps(snapshot.runSteps ?? []);
        setActiveSteps(snapshot.activeSteps ?? []);
        setPendingDecisions(snapshot.pendingDecisions ?? []);
        setRunStatus(snapshot.run?.status ?? null);
        setPauseRequested(snapshot.run?.pauseRequested === true);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load War Room snapshot");
      });
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const consumeStream = async () => {
      const response = await fetch(`${API_BASE}/api/war-room/${encodeURIComponent(runId)}/stream`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Failed to connect stream: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "message";
      let currentData = "";

      const flush = () => {
        if (!currentData.trim()) {
          currentEvent = "message";
          currentData = "";
          return;
        }
        if (currentEvent === "event") {
          try {
            const payload = JSON.parse(currentData) as WarRoomEvent;
            setEvents((current) => mergeEvents(current, [payload]));
            if (payload.type === "WORKFLOW_STATUS_UPDATE") {
              const nextStatus = payload.payload.status;
              if (typeof nextStatus === "string") {
                setRunStatus(nextStatus as RunStatus);
              }
              if (typeof payload.payload.pauseRequested === "boolean") {
                setPauseRequested(payload.payload.pauseRequested);
              }
            }
          } catch {
            // Ignore malformed stream payload chunks.
          }
        }
        currentEvent = "message";
        currentData = "";
      };

      while (!cancelled) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) {
            flush();
            continue;
          }
          if (line.startsWith(":")) {
            continue;
          }
          if (line.startsWith("event:")) {
            currentEvent = line.slice("event:".length).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            currentData += line.slice("data:".length).trim();
          }
        }
      }
    };

    consumeStream().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "War Room stream disconnected");
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, token]);

  useEffect(() => {
    if (!token || !runId) {
      return;
    }
    const timer = window.setInterval(() => {
      apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token)
        .then((snapshot) => {
          setRunSteps(snapshot.runSteps ?? []);
          setActiveSteps(snapshot.activeSteps ?? []);
          setPendingDecisions(snapshot.pendingDecisions ?? []);
          setRunStatus(snapshot.run?.status ?? null);
          setPauseRequested(snapshot.run?.pauseRequested === true);
        })
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [runId, token]);

  const threatFeed = useMemo(() => events.filter((event) => event.type === "AGENT_ALERT"), [events]);
  const debateFeed = useMemo(() => events.filter((event) => event.type === "DEBATE_RESULT"), [events]);
  const timeline = useMemo(
    () => [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
    [events]
  );
  const activeStepIds = useMemo(() => {
    const ids = new Set<string>();
    for (const step of activeSteps) {
      const candidate = step.stepId ?? step.id;
      if (typeof candidate === "string" && candidate.trim()) {
        ids.add(candidate);
      }
    }
    return ids;
  }, [activeSteps]);
  const workflowFlow = useMemo(() => {
    return runSteps
      .map((step) => {
        const stepId = typeof step.stepId === "string" ? step.stepId : "";
        const stepName = readStepLabel(step);
        const kind = typeof step.kind === "string" ? step.kind : "STEP";
        const status = typeof step.status === "string" ? step.status : "PENDING";
        if (!stepId) {
          return null;
        }
        return { id: stepId, label: stepName || stepId, kind, status };
      })
      .filter((step): step is { id: string; label: string; kind: string; status: string } => Boolean(step));
  }, [runSteps]);
  const stepLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of runSteps) {
      const stepId = typeof step.stepId === "string" ? step.stepId : "";
      if (!stepId) {
        continue;
      }
      map.set(stepId, readStepLabel(step));
    }
    return map;
  }, [runSteps]);
  const recentEventCount = useMemo(() => {
    const now = Date.now();
    return timeline.filter((event) => now - Date.parse(event.timestamp) <= 120_000).length;
  }, [timeline]);
  const requestsInFlight = Math.max(activeSteps.length, Math.min(8, Math.max(2, Math.ceil(recentEventCount / 2))));
  const stepCounts = useMemo(() => {
    let completed = 0;
    let failed = 0;
    let waiting = 0;
    for (const step of runSteps) {
      const status = typeof step.status === "string" ? step.status : "";
      if (status === "COMPLETED") completed += 1;
      if (status === "FAILED" || status === "REJECTED") failed += 1;
      if (status === "WAITING_APPROVAL") waiting += 1;
    }
    return { completed, failed, waiting, total: runSteps.length };
  }, [runSteps]);
  const completionRate = stepCounts.total > 0 ? Math.round((stepCounts.completed / stepCounts.total) * 100) : 0;

  function appendDebatesToReport() {
    if (debateFeed.length === 0) {
      setStatus("No debate results available.");
      return;
    }
    const section = debateFeed
      .map((event, index) => {
        const payload = event.payload;
        const args = Array.isArray(payload.arguments)
          ? payload.arguments
              .map((arg, argIndex) => {
                const row = arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {};
                return `- Arg ${argIndex + 1}: ${readString(row.provider, "model")}/${readString(row.model, "default")} ${readString(row.summary, "")}`.trim();
              })
              .join("\n")
          : "No arguments";
        return [
          `### Debate ${index + 1}`,
          `- Time: ${new Date(event.timestamp).toLocaleString()}`,
          `- Topic: ${readString(payload.topic)}`,
          `- Recommendation: ${readRecommendation(payload.finalRecommendation)}`,
          args
        ].join("\n");
      })
      .join("\n\n");
    setReportText((current) => (current ? `${current}\n\n${section}` : section));
    setStatus(`Appended ${debateFeed.length} debate result(s).`);
  }

  function downloadReport() {
    const content = reportText.trim();
    if (!content) {
      setStatus("Report is empty.");
      return;
    }
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `war-room-report-${runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Report downloaded.");
  }

  async function submitDecision(routerStepId: string, decision: "approve" | "reject") {
    if (!token || !runId) {
      return;
    }
    try {
      await apiFetch<{ run: { status: RunStatus } }>(
        "/api/war-room/decision",
        {
          method: "POST",
          body: JSON.stringify({ runId, routerStepId, decision })
        },
        token
      );
      setStatus(`Decision submitted: ${decision} (${routerStepId})`);
      const snapshot = await apiFetch<WarRoomSnapshot>(`/api/war-room/${encodeURIComponent(runId)}/events`, {}, token);
      setRunSteps(snapshot.runSteps ?? []);
      setActiveSteps(snapshot.activeSteps ?? []);
      setPendingDecisions(snapshot.pendingDecisions ?? []);
      setRunStatus(snapshot.run?.status ?? null);
      setPauseRequested(snapshot.run?.pauseRequested === true);
      setEvents((current) => mergeEvents(current, snapshot.events ?? []));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit decision");
    }
  }

  async function togglePauseRun() {
    if (!token || !runId) {
      return;
    }
    setIsControllingRun(true);
    setStatus(null);
    setError(null);
    try {
      const endpoint = pauseRequested ? "/api/war-room/resume" : "/api/war-room/pause";
      const snapshot = await apiFetch<WarRoomSnapshot>(
        endpoint,
        {
          method: "POST",
          body: JSON.stringify({ runId })
        },
        token
      );
      setEvents((current) => mergeEvents(current, snapshot.events ?? []));
      setRunSteps(snapshot.runSteps ?? []);
      setActiveSteps(snapshot.activeSteps ?? []);
      setPendingDecisions(snapshot.pendingDecisions ?? []);
      setRunStatus(snapshot.run?.status ?? null);
      setPauseRequested(snapshot.run?.pauseRequested === true);
      setStatus(pauseRequested ? "Run resumed." : "Pause requested. Current step will stop before next step.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update run state");
    } finally {
      setIsControllingRun(false);
    }
  }

  async function runInterpreter() {
    if (!token || !runId) {
      return;
    }
    setInterpreting(true);
    setInterpreterError(null);
    try {
      const payload = await apiFetch<WarRoomInterpretation>(
        `/api/war-room/${encodeURIComponent(runId)}/interpret`,
        {
          method: "POST",
          body: JSON.stringify({ focus: interpreterFocus || undefined })
        },
        token
      );
      setInterpretation(payload);
    } catch (err) {
      setInterpreterError(err instanceof Error ? err.message : "Failed to interpret workflow run");
    } finally {
      setInterpreting(false);
    }
  }

  if (!runId) {
    return <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">Missing runId query param.</div>;
  }

  return (
    <div className="space-y-4">
      <section className="warroom-onair rounded border border-slate-700 p-4 text-slate-100">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 inline-flex items-center gap-2 rounded border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold tracking-wide text-rose-100">
              <span className="warroom-pulse h-2 w-2 rounded-full bg-rose-400" />
              ON AIR
            </div>
            <h1 className="text-2xl font-semibold">War Room</h1>
            <p className="mt-1 text-sm text-slate-200">Live execution board optimized for fast operational readouts.</p>
          </div>
          <div className="flex gap-2">
            {(runStatus === "COMPLETED" || runStatus === "FAILED" || runStatus === "REJECTED") ? (
              <button
                className="rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                onClick={() => navigate(`/runs/${encodeURIComponent(runId)}/report`)}
                type="button"
              >
                {runStatus === "COMPLETED" ? "Check Report" : "View Report"}
              </button>
            ) : null}
            <button
              className="rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isControllingRun || runStatus === "COMPLETED" || runStatus === "FAILED" || runStatus === "REJECTED"}
              onClick={togglePauseRun}
              type="button"
            >
              {isControllingRun ? "Updating..." : pauseRequested ? "Resume Run" : "Pause Run"}
            </button>
            <button
              className="rounded border border-slate-400 px-3 py-1.5 text-xs font-semibold text-slate-100"
              onClick={() => navigate("/workflows")}
              type="button"
            >
              Back to Builder
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-200">
          <span className="rounded border border-slate-600 bg-slate-800/70 px-2 py-1">
            Run: <span className="font-mono">{runId}</span>
          </span>
          <span className={`rounded border px-2 py-1 font-semibold ${statusBadgeClass(runStatus)}`}>
            {runStatus ?? "UNKNOWN"}
          </span>
          <span className="rounded border border-slate-600 bg-slate-800/70 px-2 py-1">Paused: {pauseRequested ? "yes" : "no"}</span>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <article className="rounded border border-slate-300 bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Run Status</div>
          <div className={`mt-2 inline-flex rounded border px-2 py-1 text-sm font-semibold ${statusBadgeClass(runStatus)}`}>
            {runStatus ?? "UNKNOWN"}
          </div>
        </article>
        <article className="rounded border border-slate-300 bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Completion</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{completionRate}%</div>
          <div className="text-xs text-slate-600">
            {stepCounts.completed}/{stepCounts.total} steps
          </div>
        </article>
        <article className="rounded border border-slate-300 bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active Steps</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{activeSteps.length}</div>
          <div className="text-xs text-slate-600">Requests in flight: {requestsInFlight}</div>
        </article>
        <article className="rounded border border-slate-300 bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pending Decisions</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{pendingDecisions.length}</div>
          <div className="text-xs text-slate-600">Waiting approvals: {stepCounts.waiting}</div>
        </article>
        <article className="rounded border border-slate-300 bg-white p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event Activity</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{recentEventCount}</div>
          <div className="text-xs text-slate-600">last 2 minutes</div>
        </article>
      </section>

      {status ? <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{status}</p> : null}
      {error ? <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-warn">{error}</p> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(460px,1.4fr)_minmax(0,1fr)]">
        <section className="flex min-h-[520px] flex-col rounded border border-cyan-200 bg-cyan-50 p-4 xl:col-start-2 xl:row-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-cyan-900">Live Workflow Flow</h2>
            <div className="text-xs text-cyan-800">
              Active steps: <span className="font-semibold">{activeSteps.length}</span> | Request signals:{" "}
              <span className="font-semibold">{recentEventCount}</span>
            </div>
          </div>
          <div className="mt-3 flex flex-1 items-center overflow-x-auto pb-2">
            {workflowFlow.length === 0 ? (
              <p className="text-sm text-slate-600">No workflow steps loaded for this run yet.</p>
            ) : (
              <div className="inline-flex min-w-full items-center gap-2">
              {workflowFlow.map((step, index) => {
                const isActive = activeStepIds.has(step.id);
                return (
                  <div className="flex items-center gap-2" key={step.id}>
                    <article
                      className={[
                        "min-w-[130px] rounded border bg-white px-3 py-2",
                        isActive
                          ? "border-emerald-300 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]"
                          : "border-cyan-200"
                      ].join(" ")}
                    >
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">{step.kind}</div>
                      <div className="text-sm font-medium text-slate-900">{step.label}</div>
                      <div className={["text-[11px]", isActive ? "text-emerald-700" : "text-slate-500"].join(" ")}>
                        {isActive ? "processing" : step.status.toLowerCase()}
                      </div>
                    </article>
                    {index < workflowFlow.length - 1 ? (
                      <div className="relative h-2 w-20 overflow-hidden rounded-full bg-cyan-100 sm:w-28">
                        <div className="absolute inset-y-0 left-0 right-0 my-auto h-[2px] bg-cyan-300" />
                        {Array.from({ length: requestsInFlight }).map((_, dotIndex) => (
                          <span
                            className="war-room-flow-dot absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-cyan-500"
                            key={`${step.id}-dot-${dotIndex}`}
                            style={{
                              animationDelay: `${dotIndex * 0.35}s`,
                              animationDuration: `${2.2 + (dotIndex % 3) * 0.4}s`
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-600">Moving dots represent request packets traversing step-to-step workflow links.</p>
        </section>

        <section className="rounded border border-rose-200 bg-rose-50 p-4 xl:col-start-1 xl:row-start-1">
          <h2 className="text-lg font-semibold text-rose-900">Threat Feed</h2>
          <div className="mt-3 space-y-2">
            {threatFeed.map((event) => (
              <article className="rounded border border-rose-200 bg-white p-3" key={`${event.id ?? event.timestamp}-${event.stepId ?? ""}`}>
                <div className="text-sm font-medium text-slate-900">
                  {readString(event.payload.summary, event.stepId ? stepLabelById.get(event.stepId) ?? event.stepId : "Agent alert")}
                </div>
                <div className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</div>
                <div className="mt-1 text-xs text-rose-800">
                  Category: {readString(event.payload.category)} | Severity: {readString(event.payload.severity, "medium")} | Risk:{" "}
                  {readString(event.payload.riskScore, "n/a")}
                </div>
              </article>
            ))}
            {threatFeed.length === 0 ? <p className="text-sm text-slate-500">No active alerts.</p> : null}
          </div>
        </section>

        <section className="rounded border border-orange-200 bg-orange-50 p-4 xl:col-start-3 xl:row-start-1">
          <h2 className="text-lg font-semibold text-orange-900">AI Debate Panel</h2>
          <div className="mt-3 space-y-2">
            {debateFeed.map((event, index) => (
              <article className="rounded border border-orange-200 bg-white p-3" key={`${event.id ?? event.timestamp}-${index}`}>
                <div className="text-sm font-medium text-slate-900">
                  {readString(event.payload.topic, event.stepId ? stepLabelById.get(event.stepId) ?? event.stepId : "Debate")}
                </div>
                <div className="mt-1 text-xs text-orange-800">Final: {readRecommendation(event.payload.finalRecommendation)}</div>
                <div className="mt-1 text-xs text-slate-500">Confidence: {readConfidence(event.payload.confidence, "n/a")}</div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-slate-600">Arguments</summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                    {JSON.stringify(event.payload.arguments ?? [], null, 2)}
                  </pre>
                </details>
              </article>
            ))}
            {debateFeed.length === 0 ? <p className="text-sm text-slate-500">No debate results yet.</p> : null}
          </div>
          <div className="mt-3 rounded border border-orange-200 bg-white p-3">
            <div className="flex flex-wrap gap-2">
              <button className="rounded bg-orange-600 px-2 py-1 text-xs font-medium text-white" onClick={appendDebatesToReport} type="button">
                Append Debate Results
              </button>
              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={downloadReport} type="button">
                Download Report
              </button>
              <button className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700" onClick={() => setReportText("")} type="button">
                Clear
              </button>
            </div>
            <textarea
              className="mt-2 h-32 w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-800"
              readOnly
              value={reportText || "Report is empty."}
            />
          </div>
        </section>

        <section className="rounded border border-indigo-200 bg-indigo-50 p-4 xl:col-start-1 xl:row-start-3">
          <h2 className="text-lg font-semibold text-indigo-900">AI Workflow Interpreter</h2>
          <p className="mt-1 text-xs text-indigo-800">
            Plain-language interpretation of current run state for any role.
          </p>
          <input
            className="mt-2 w-full rounded border border-indigo-300 px-2 py-1 text-sm"
            onChange={(event) => setInterpreterFocus(event.target.value)}
            placeholder="Optional focus (ex: explain bottlenecks and next decision)"
            value={interpreterFocus}
          />
          <button
            className="mt-2 rounded bg-indigo-700 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
            disabled={interpreting}
            onClick={() => runInterpreter().catch(() => undefined)}
            type="button"
          >
            {interpreting ? "Interpreting..." : "Interpret Run"}
          </button>
          {interpreterError ? <p className="mt-2 text-xs text-warn">{interpreterError}</p> : null}
          {interpretation ? (
            <article className="mt-3 rounded border border-indigo-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={`rounded px-2 py-0.5 ${
                    interpretation.mockMode ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {interpretation.mockMode ? "Mock Interpreter" : "Live Interpreter"}
                </span>
                <span className="rounded bg-slate-100 px-2 py-0.5">{interpretation.provider}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5">{interpretation.model}</span>
                <span className="text-slate-600">confidence {interpretation.interpretation.confidence.toFixed(2)}</span>
              </div>
              <div className="mt-2 text-sm text-slate-900">{interpretation.interpretation.summary}</div>
              <div className="mt-1 text-xs text-slate-600">{interpretation.interpretation.rationale}</div>
            </article>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No interpretation yet.</p>
          )}
        </section>

        <section className="rounded border border-emerald-200 bg-emerald-50 p-4 xl:col-start-1 xl:row-start-2">
          <h2 className="text-lg font-semibold text-emerald-900">Decision Console</h2>
          <div className="mt-2 text-xs text-slate-600">Active steps: {activeSteps.length}</div>
          <div className="mt-3 space-y-2">
            {pendingDecisions.map((item) => (
              <article className="rounded border border-emerald-200 bg-white p-3" key={item.id}>
                <div className="text-sm font-medium text-slate-900">
                  Router step: {stepLabelById.get(item.routerStepId) ?? item.routerStepId}
                </div>
                <div className="text-xs text-slate-500">Requested: {new Date(item.requestedAt).toLocaleString()}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                    onClick={() => submitDecision(item.routerStepId, "approve")}
                    type="button"
                  >
                    Approve
                  </button>
                  <button
                    className="rounded bg-rose-600 px-2 py-1 text-xs font-medium text-white"
                    onClick={() => submitDecision(item.routerStepId, "reject")}
                    type="button"
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
            {pendingDecisions.length === 0 ? <p className="text-sm text-slate-500">No router decisions pending.</p> : null}
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4 xl:col-start-3 xl:row-start-2">
          <h2 className="text-lg font-semibold text-slate-900">System Timeline</h2>
          <div className="mt-3 max-h-[540px] space-y-2 overflow-auto pr-1">
            {timeline.map((event, index) => (
              <article className="rounded border border-slate-200 p-3" key={`${event.id ?? event.timestamp}-${index}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900">{event.type}</div>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                    {event.stepId ? stepLabelById.get(event.stepId) ?? event.stepId : "run"}
                  </span>
                </div>
                <div className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</div>
                <pre className="mt-2 max-h-36 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </article>
            ))}
            {timeline.length === 0 ? <p className="text-sm text-slate-500">No events yet.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
