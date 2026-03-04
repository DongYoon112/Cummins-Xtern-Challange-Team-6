import { useEffect, useMemo, useState } from "react";
import { DevBuilder } from "../components/DevBuilder";
import { FlowBuilder } from "../components/FlowBuilder";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  WORKFLOW_DRAFT_STORAGE_KEY,
  createDefaultWorkflowConfig,
  validateFlowGraph,
  type WorkflowConfig
} from "../lib/workflowBuilderSchema";

type BuilderMode = "flowchart" | "developer";

type DraftPayload = {
  id: string;
  name: string;
  config: WorkflowConfig;
  updatedAt: string;
};

export function WorkflowsPage() {
  const { token, user } = useAuth();
  const [mode, setMode] = useState<BuilderMode>("flowchart");
  const [config, setConfig] = useState<WorkflowConfig>(() => {
    if (typeof window === "undefined") {
      return createDefaultWorkflowConfig();
    }

    try {
      const raw = window.localStorage.getItem(WORKFLOW_DRAFT_STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw) as WorkflowConfig;
      }
    } catch {
      // no-op
    }
    return createDefaultWorkflowConfig();
  });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverDraftUpdatedAt, setServerDraftUpdatedAt] = useState<string | null>(null);

  const canSave = user?.role === "BUILDER";
  const graphValidation = useMemo(() => validateFlowGraph(config.graph ?? { nodes: [], edges: [] }), [config.graph]);

  useEffect(() => {
    if (!token) {
      return;
    }

    apiFetch<DraftPayload | { draft: DraftPayload | null }>("/workflows/draft", {}, token)
      .then((payload) => {
        const draft = "draft" in payload ? payload.draft : payload;
        if (!draft) {
          return;
        }
        setConfig(draft.config);
        setServerDraftUpdatedAt(draft.updatedAt);
      })
      .catch(() => {
        // keep local draft only
      });
  }, [token]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(WORKFLOW_DRAFT_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  async function saveDraft() {
    setStatus(null);
    setError(null);

    if (!canSave) {
      setError("Only BUILDER role can save draft to API.");
      return;
    }

    if (!graphValidation.valid) {
      setError(graphValidation.errors.join(" "));
      return;
    }

    try {
      window.localStorage.setItem(WORKFLOW_DRAFT_STORAGE_KEY, JSON.stringify(config));
      const payload = await apiFetch<{ draft: DraftPayload }>(
        "/workflows/draft",
        {
          method: "POST",
          body: JSON.stringify({
            id: config.id,
            name: config.name,
            config
          })
        },
        token ?? undefined
      );
      setServerDraftUpdatedAt(payload.draft.updatedAt);
      setStatus("Draft saved to localStorage and API.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft");
    }
  }

  function resetDraft() {
    const next = createDefaultWorkflowConfig();
    setConfig(next);
    window.localStorage.setItem(WORKFLOW_DRAFT_STORAGE_KEY, JSON.stringify(next));
    setStatus("Draft reset.");
    setError(null);
  }

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Agent Workflow Builder - Step 1</h2>
            <p className="text-xs text-slate-500">
              Choose Agent Type + Core Tools. Modes stay synchronized through one shared JSON schema.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`rounded px-3 py-1 text-sm ${mode === "flowchart" ? "bg-accent text-white" : "bg-slate-100"}`}
              onClick={() => setMode("flowchart")}
              type="button"
            >
              Flowchart
            </button>
            <button
              className={`rounded px-3 py-1 text-sm ${mode === "developer" ? "bg-accent text-white" : "bg-slate-100"}`}
              onClick={() => setMode("developer")}
              type="button"
            >
              Developer
            </button>
            <button className="rounded border border-slate-300 px-3 py-1 text-sm" onClick={resetDraft} type="button">
              Reset
            </button>
            <button
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white"
              disabled={!canSave}
              onClick={saveDraft}
              type="button"
            >
              Save Draft
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
          <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
            Validation: {graphValidation.valid ? "Passed" : graphValidation.errors.join(" ")}
          </div>
          <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
            Last API draft: {serverDraftUpdatedAt ?? "none"}
          </div>
        </div>
      </section>

      {mode === "flowchart" ? (
        <FlowBuilder config={config} onConfigChange={setConfig} />
      ) : (
        <DevBuilder config={config} onConfigChange={setConfig} />
      )}

      <section className="rounded border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold">Preview JSON</h3>
        <pre className="mt-2 max-h-[360px] overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {JSON.stringify(config, null, 2)}
        </pre>
      </section>

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </div>
  );
}
