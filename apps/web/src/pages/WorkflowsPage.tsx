import { Fragment, useEffect, useMemo, useState } from "react";
import { DevBuilder } from "../components/DevBuilder";
import { FlowBuilder } from "../components/FlowBuilder";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { WorkflowSummary } from "../lib/types";
import {
  WORKFLOW_DRAFT_STORAGE_KEY,
  createDefaultWorkflowConfig,
  validateFlowGraph,
  type WorkflowConfig
} from "../lib/workflowBuilderSchema";

type BuilderMode = "flowchart" | "developer";
type PageMode = "dashboard" | "builder";

type DraftPayload = {
  id: string;
  name: string;
  config: WorkflowConfig;
  updatedAt: string;
};

type WorkflowVersionDetails = {
  workflowId: string;
  name?: string;
  description?: string;
  version?: number;
  createdAt?: string;
  steps?: Array<{
    id?: string;
    name?: string;
    kind?: "AGENT" | "APPROVAL";
    agentName?: string;
    params?: Record<string, unknown>;
  }>;
};

type PublishPayload = {
  workflowId: string;
  version: number;
  sourceDraftId: string;
};

type AiTemplate = "ops_runbook" | "research_memo" | "data_analysis" | "code_helper";
type AiRisk = "low" | "medium" | "high";
type AiProvider = "openai" | "anthropic" | "gemini";

type DraftGenerateResponse = {
  draft: {
    id: string;
    name: string;
    config: WorkflowConfig;
  };
  notes: string[];
  risks: string[];
};

const AI_TOOL_CHOICES = [
  { id: "web", label: "Web" },
  { id: "http", label: "HTTP" },
  { id: "db_read", label: "DB Read" },
  { id: "file_write", label: "File Write" },
  { id: "email_send", label: "Email" },
  { id: "code", label: "Code" }
] as const;

function normalizeWorkflowSummary(input: unknown): WorkflowSummary | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Record<string, unknown>;
  if (
    typeof value.workflowId !== "string" ||
    typeof value.teamId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.latestVersion !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    workflowId: value.workflowId,
    teamId: value.teamId,
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    latestVersion: value.latestVersion,
    updatedAt: value.updatedAt,
    forkedFrom: typeof value.forkedFrom === "string" ? value.forkedFrom : undefined
  };
}

function normalizeWorkflowVersionDetails(input: unknown): WorkflowVersionDetails | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = input as Record<string, unknown>;
  if (typeof value.workflowId !== "string") {
    return null;
  }

  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps.map((step) => {
    const record = typeof step === "object" && step !== null ? (step as Record<string, unknown>) : {};
    const kind =
      record.kind === "AGENT" || record.kind === "APPROVAL" ? (record.kind as "AGENT" | "APPROVAL") : undefined;
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      kind,
      agentName: typeof record.agentName === "string" ? record.agentName : undefined,
      params: typeof record.params === "object" && record.params !== null ? (record.params as Record<string, unknown>) : {}
    };
  });

  return {
    workflowId: value.workflowId,
    name: typeof value.name === "string" ? value.name : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    version: typeof value.version === "number" ? value.version : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    steps
  };
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toLocaleString();
}

function repoDraftStorageKey(repoId: string) {
  return `${WORKFLOW_DRAFT_STORAGE_KEY}.${repoId}`;
}

export function WorkflowsPage() {
  const { token, user } = useAuth();
  const [pageMode, setPageMode] = useState<PageMode>("dashboard");
  const [builderUnlocked, setBuilderUnlocked] = useState(false);
  const [mode, setMode] = useState<BuilderMode>("flowchart");
  const [config, setConfig] = useState<WorkflowConfig>(() => createDefaultWorkflowConfig());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverDraftUpdatedAt, setServerDraftUpdatedAt] = useState<string | null>(null);
  const [workflowList, setWorkflowList] = useState<WorkflowSummary[]>([]);
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [expandedWorkflowId, setExpandedWorkflowId] = useState<string | null>(null);
  const [workflowDetailsById, setWorkflowDetailsById] = useState<Record<string, WorkflowVersionDetails>>({});
  const [workflowDetailsLoadingById, setWorkflowDetailsLoadingById] = useState<Record<string, boolean>>({});
  const [workflowDetailsErrorById, setWorkflowDetailsErrorById] = useState<Record<string, string>>({});
  const [showCreateRepository, setShowCreateRepository] = useState(false);
  const [newRepositoryName, setNewRepositoryName] = useState("");
  const [newRepositoryDescription, setNewRepositoryDescription] = useState("");
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("Publish draft");
  const [publishedWorkflowId, setPublishedWorkflowId] = useState<string | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiFeedback, setAiFeedback] = useState("");
  const [aiTemplate, setAiTemplate] = useState<AiTemplate>("ops_runbook");
  const [aiRiskLevel, setAiRiskLevel] = useState<AiRisk>("medium");
  const [aiProvider, setAiProvider] = useState<AiProvider>("openai");
  const [aiAllowedTools, setAiAllowedTools] = useState<string[]>(["web", "http", "db_read"]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [aiRisks, setAiRisks] = useState<string[]>([]);

  const canSave = user?.role === "BUILDER" || user?.role === "ADMIN";
  const graphValidation = useMemo(() => validateFlowGraph(config.graph ?? { nodes: [], edges: [] }), [config.graph]);
  const filteredWorkflowList = useMemo(() => {
    const query = workflowFilter.trim().toLowerCase();
    if (!query) {
      return workflowList;
    }

    return workflowList.filter((workflow) => {
      return (
        workflow.name.toLowerCase().includes(query) ||
        workflow.workflowId.toLowerCase().includes(query) ||
        (workflow.description ?? "").toLowerCase().includes(query)
      );
    });
  }, [workflowFilter, workflowList]);

  async function loadWorkflows() {
    if (!token) {
      return;
    }

    setWorkflowLoading(true);
    setWorkflowError(null);

    try {
      const payload = await apiFetch<{ workflows: unknown[] }>("/workflows", {}, token);
      const workflows = (payload.workflows ?? [])
        .map((entry) => normalizeWorkflowSummary(entry))
        .filter((entry): entry is WorkflowSummary => Boolean(entry))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      setWorkflowList(workflows);
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : "Failed to load workflows");
    } finally {
      setWorkflowLoading(false);
    }
  }

  async function copyWorkflowId(workflowId: string) {
    try {
      await navigator.clipboard.writeText(workflowId);
      setStatus(`Copied workflow ID: ${workflowId}`);
      setError(null);
    } catch {
      // Fallback for environments where clipboard API is unavailable.
      const input = document.createElement("textarea");
      input.value = workflowId;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.focus();
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setStatus(`Copied workflow ID: ${workflowId}`);
      setError(null);
    }
  }

  async function loadWorkflowDetails(workflowId: string) {
    if (!token) {
      return;
    }

    if (workflowDetailsById[workflowId]) {
      return;
    }

    setWorkflowDetailsLoadingById((current) => ({ ...current, [workflowId]: true }));
    setWorkflowDetailsErrorById((current) => ({ ...current, [workflowId]: "" }));

    try {
      const payload = await apiFetch<unknown>(`/workflows/${workflowId}`, {}, token);
      const parsed = normalizeWorkflowVersionDetails(payload);
      if (!parsed) {
        throw new Error("Invalid workflow payload");
      }
      setWorkflowDetailsById((current) => ({ ...current, [workflowId]: parsed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load summary";
      setWorkflowDetailsErrorById((current) => ({ ...current, [workflowId]: message }));
    } finally {
      setWorkflowDetailsLoadingById((current) => ({ ...current, [workflowId]: false }));
    }
  }

  function openWorkflowInBuilder(workflow: WorkflowSummary) {
    const nextRepoId = workflow.workflowId;
    let nextConfig: WorkflowConfig | null = null;
    try {
      const raw = window.localStorage.getItem(repoDraftStorageKey(nextRepoId));
      if (raw) {
        nextConfig = JSON.parse(raw) as WorkflowConfig;
      }
    } catch {
      // ignore invalid local draft
    }

    if (!nextConfig) {
      const base = createDefaultWorkflowConfig();
      nextConfig = {
        ...base,
        id: nextRepoId,
        name: workflow.name,
        description: workflow.description ?? ""
      };
    } else {
      nextConfig = {
        ...nextConfig,
        id: nextRepoId,
        name: nextConfig.name || workflow.name,
        description: typeof nextConfig.description === "string" ? nextConfig.description : workflow.description ?? ""
      };
    }

    setSelectedWorkflowId(workflow.workflowId);
    setActiveRepoId(nextRepoId);
    setConfig(nextConfig);
    setBuilderUnlocked(true);
    setPageMode("builder");
    setMode("flowchart");
    setPublishedWorkflowId(workflow.workflowId);
    setPublishedVersion(workflow.latestVersion);
    setStatus(`Opened ${workflow.name} in Builder.`);
    setError(null);
  }

  function createNewWorkflow(name?: string, description?: string) {
    const next = createDefaultWorkflowConfig();
    const repoName = (name ?? "").trim();
    const nextConfig = {
      ...next,
      name: repoName || next.name,
      description: (description ?? "").trim()
    };
    setConfig(nextConfig);
    setSelectedWorkflowId(next.id);
    setActiveRepoId(next.id);
    setBuilderUnlocked(true);
    setPageMode("builder");
    setMode("flowchart");
    setPublishedWorkflowId(null);
    setPublishedVersion(null);
    window.localStorage.setItem(repoDraftStorageKey(next.id), JSON.stringify(nextConfig));
    setShowCreateRepository(false);
    setNewRepositoryName("");
    setNewRepositoryDescription("");
    setStatus("Created new workflow draft.");
    setError(null);
  }

  function createRepositoryFromForm() {
    const name = newRepositoryName.trim();
    const isValidName = /^[a-zA-Z0-9._-]{2,64}$/.test(name);
    if (!isValidName) {
      setError("Repository name must be 2-64 chars and use letters, numbers, dot, dash, or underscore.");
      return;
    }
    createNewWorkflow(name, newRepositoryDescription);
  }

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
        setServerDraftUpdatedAt(draft.updatedAt);
      })
      .catch(() => undefined);

    loadWorkflows().catch(() => undefined);
  }, [token]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!activeRepoId) {
      return;
    }
    window.localStorage.setItem(repoDraftStorageKey(activeRepoId), JSON.stringify(config));
  }, [activeRepoId, config]);

  async function saveDraftToApi() {
    if (!canSave) {
      throw new Error("Only BUILDER or ADMIN role can save draft to API.");
    }

    if (!graphValidation.valid) {
      throw new Error(graphValidation.errors.join(" "));
    }

    if (activeRepoId) {
      window.localStorage.setItem(repoDraftStorageKey(activeRepoId), JSON.stringify(config));
    }

    return apiFetch<{ draft: DraftPayload }>(
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
  }

  async function saveDraft() {
    setStatus(null);
    setError(null);

    try {
      const payload = await saveDraftToApi();
      setServerDraftUpdatedAt(payload.draft.updatedAt);
      setStatus("Draft saved to localStorage and API.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft");
    }
  }

  async function publishWorkflow() {
    setStatus(null);
    setError(null);

    try {
      const saved = await saveDraftToApi();
      setServerDraftUpdatedAt(saved.draft.updatedAt);

      const payload = await apiFetch<PublishPayload>(
        `/workflows/draft/${encodeURIComponent(config.id)}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            changelog: commitMessage.trim() || "Publish draft"
          })
        },
        token ?? undefined
      );

      const normalizedConfig: WorkflowConfig = {
        ...config,
        id: payload.workflowId
      };
      setConfig(normalizedConfig);
      setActiveRepoId(payload.workflowId);
      setSelectedWorkflowId(payload.workflowId);
      setPublishedWorkflowId(payload.workflowId);
      setPublishedVersion(payload.version);
      window.localStorage.setItem(repoDraftStorageKey(payload.workflowId), JSON.stringify(normalizedConfig));

      await loadWorkflows();
      setStatus(`Published workflow ${payload.workflowId} v${payload.version}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish workflow");
    }
  }

  async function runLatest() {
    setStatus(null);
    setError(null);

    const workflowId = publishedWorkflowId ?? config.id;
    if (!workflowId) {
      setError("Publish the draft before running latest.");
      return;
    }

    try {
      const payload = await apiFetch<{ run: { runId: string } }>(
        "/runs",
        {
          method: "POST",
          body: JSON.stringify({
            workflowId,
            workflowVersion: publishedVersion ?? undefined
          })
        },
        token ?? undefined
      );
      setStatus(`Run started: ${payload.run.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  function toggleAiTool(toolId: string) {
    setAiAllowedTools((current) =>
      current.includes(toolId) ? current.filter((item) => item !== toolId) : [...current, toolId]
    );
  }

  async function generateWithAi(mode: "generate" | "refine") {
    setStatus(null);
    setError(null);

    if (!canSave) {
      setError("Only BUILDER or ADMIN role can generate drafts.");
      return;
    }

    if (!aiPrompt.trim()) {
      setError("Enter a workflow intent prompt first.");
      return;
    }

    setAiBusy(true);
    try {
      const requireApprovalsFor = ["http_post", "file_write"];
      const payload = await apiFetch<DraftGenerateResponse>(
        "/workflows/draft/generate",
        {
          method: "POST",
          body: JSON.stringify({
            prompt: aiPrompt.trim(),
            feedback: mode === "refine" ? aiFeedback.trim() : undefined,
            currentConfig: mode === "refine" ? config : undefined,
            constraints: {
              goalTemplate: aiTemplate,
              allowedTools: aiAllowedTools,
              requireApprovalsFor,
              provider: aiProvider,
              riskLevel: aiRiskLevel,
              budget: { maxSteps: 25 }
            }
          })
        },
        token ?? undefined
      );

      setConfig(payload.draft.config);
      setActiveRepoId(payload.draft.id);
      setSelectedWorkflowId(payload.draft.id);
      setBuilderUnlocked(true);
      setPageMode("builder");
      setAiNotes(payload.notes ?? []);
      setAiRisks(payload.risks ?? []);
      setStatus(mode === "refine" ? "Draft refined by AI." : "Draft generated by AI.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate draft");
    } finally {
      setAiBusy(false);
    }
  }

  function resetDraft() {
    const next = createDefaultWorkflowConfig();
    const resetConfig: WorkflowConfig = {
      ...next,
      id: activeRepoId ?? next.id,
      name: activeRepoId ? config.name : next.name,
      description: activeRepoId ? config.description ?? "" : next.description ?? ""
    };
    setConfig(resetConfig);
    if (activeRepoId) {
      window.localStorage.setItem(repoDraftStorageKey(activeRepoId), JSON.stringify(resetConfig));
    }
    setStatus("Draft reset.");
    setError(null);
  }

  return (
    <div className="space-y-4">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Workflows</h2>
            <p className="text-xs text-slate-500">
              Dashboard lists all saved workflows. Builder edits your draft graph and config.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`rounded px-3 py-1 text-sm ${pageMode === "dashboard" ? "bg-accent text-white" : "bg-slate-100"}`}
              onClick={() => setPageMode("dashboard")}
              type="button"
            >
              Dashboard
            </button>
            <button
              className={`rounded px-3 py-1 text-sm ${
                pageMode === "builder" ? "bg-accent text-white" : "bg-slate-100"
              } ${!builderUnlocked ? "cursor-not-allowed opacity-50" : ""}`}
              disabled={!builderUnlocked}
              onClick={() => {
                if (builderUnlocked) {
                  setPageMode("builder");
                }
              }}
              type="button"
            >
              Builder
            </button>
            <button
              className="rounded border border-slate-300 px-3 py-1 text-sm"
              onClick={() => setShowCreateRepository((current) => !current)}
              type="button"
            >
              New Repository
            </button>
          </div>
        </div>
        {!builderUnlocked ? (
          <p className="mt-2 text-xs text-slate-500">
            To enter Builder, select a repository from the list or create a new repository.
          </p>
        ) : null}
      </section>

      {pageMode === "dashboard" ? (
        <>
          {showCreateRepository ? (
            <section className="rounded border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold">Create a new repository</h3>
              <p className="mt-1 text-xs text-slate-500">
                This repository will become your workflow draft space, similar to creating a GitHub repository.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  <div className="mb-1 text-slate-700">Repository name</div>
                  <input
                    className="w-full rounded border border-slate-300 px-2 py-1"
                    onChange={(event) => setNewRepositoryName(event.target.value)}
                    placeholder="ex: demand-planner-agent"
                    value={newRepositoryName}
                  />
                  <div className="mt-1 text-xs text-slate-500">Allowed: letters, numbers, `.`, `-`, `_`</div>
                </label>
                <label className="text-sm">
                  <div className="mb-1 text-slate-700">Description (optional)</div>
                  <input
                    className="w-full rounded border border-slate-300 px-2 py-1"
                    onChange={(event) => setNewRepositoryDescription(event.target.value)}
                    placeholder="One-line summary of this workflow repository"
                    value={newRepositoryDescription}
                  />
                </label>
              </div>
              <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Repository preview: team-default/{newRepositoryName.trim() || "repo-name"}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button className="rounded bg-slate-900 px-3 py-1 text-sm text-white" onClick={createRepositoryFromForm} type="button">
                  Create repository
                </button>
                <button
                  className="rounded border border-slate-300 px-3 py-1 text-sm"
                  onClick={() => setShowCreateRepository(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          <section className="rounded border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Workflow Repository</h3>
              <div className="flex items-center gap-2">
                <input
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setWorkflowFilter(event.target.value)}
                  placeholder="Search by name, id, or description..."
                  value={workflowFilter}
                />
                <button
                  className="rounded border border-slate-300 px-3 py-1 text-sm"
                  onClick={() => loadWorkflows()}
                  type="button"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="mt-3 overflow-x-auto rounded border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2">Updated</th>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">Workflow ID</th>
                    <th className="px-3 py-2">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredWorkflowList.map((workflow) => {
                    const isExpanded = expandedWorkflowId === workflow.workflowId;
                    const detail = workflowDetailsById[workflow.workflowId];
                    const detailLoading = workflowDetailsLoadingById[workflow.workflowId];
                    const detailError = workflowDetailsErrorById[workflow.workflowId];
                    return (
                      <Fragment key={workflow.workflowId}>
                        <tr
                          className={`border-t border-slate-200 align-top ${
                            selectedWorkflowId === workflow.workflowId ? "bg-cyan-50" : "hover:bg-slate-50"
                          }`}
                          onClick={() => setSelectedWorkflowId(workflow.workflowId)}
                          onDoubleClick={() => openWorkflowInBuilder(workflow)}
                        >
                          <td className="px-3 py-2 font-medium text-slate-900">{workflow.name}</td>
                          <td className="px-3 py-2 text-slate-600">{workflow.description ?? "No description"}</td>
                          <td className="px-3 py-2 text-slate-600">{formatDateTime(workflow.updatedAt)}</td>
                          <td className="px-3 py-2">
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">v{workflow.latestVersion}</span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 font-mono text-xs text-slate-600">
                              <span>{workflow.workflowId}</span>
                              <button
                                aria-label="Copy workflow ID"
                                className="rounded border border-slate-300 px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  copyWorkflowId(workflow.workflowId).catch(() => undefined);
                                }}
                                title="Copy workflow ID"
                                type="button"
                              >
                                ⧉
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <button
                              className="rounded border border-slate-300 px-2 py-1 text-xs"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isExpanded) {
                                  setExpandedWorkflowId(null);
                                  return;
                                }
                                setExpandedWorkflowId(workflow.workflowId);
                                loadWorkflowDetails(workflow.workflowId).catch(() => undefined);
                              }}
                              type="button"
                            >
                              {isExpanded ? "Hide" : "Summary"}
                            </button>
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="border-t border-slate-100 bg-slate-50">
                            <td className="px-3 py-3 text-xs text-slate-700" colSpan={6}>
                              {detailLoading ? <div>Loading summary...</div> : null}
                              {detailError ? <div className="text-warn">{detailError}</div> : null}
                              {detail ? (
                                <div className="space-y-2">
                                  <div>
                                    <span className="font-semibold">Name:</span> {detail.name ?? workflow.name}
                                  </div>
                                  <div>
                                    <span className="font-semibold">Version:</span> {detail.version ?? workflow.latestVersion}
                                  </div>
                                  <div>
                                    <span className="font-semibold">Created:</span>{" "}
                                    {detail.createdAt ? formatDateTime(detail.createdAt) : "N/A"}
                                  </div>
                                  <div>
                                    <span className="font-semibold">Description:</span>{" "}
                                    {detail.description ?? workflow.description ?? "No description"}
                                  </div>
                                  <div>
                                    <span className="font-semibold">Shape:</span> {detail.steps?.length ?? 0} steps (
                                    {(detail.steps ?? []).map((step) => step.kind ?? "AGENT").join(" -> ") || "none"})
                                  </div>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              {!workflowLoading && filteredWorkflowList.length === 0 ? (
                <div className="p-3 text-sm text-slate-500">No workflows found.</div>
              ) : null}
            </div>

            {workflowLoading ? <p className="mt-2 text-xs text-slate-500">Loading workflows...</p> : null}
            {workflowError ? <p className="mt-2 text-xs text-warn">{workflowError}</p> : null}
            <p className="mt-2 text-xs text-slate-500">
              Double-click a workflow row to open Builder with that workflow selected.
            </p>
          </section>
        </>
      ) : (
        <>
          <section className="rounded border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Agent Workflow Builder - Step 1</h3>
                <p className="text-xs text-slate-500">
                  Choose Agent Type + Core Tools. Modes stay synchronized through one shared JSON schema.
                </p>
              </div>
              <div className="grid w-full gap-2 md:max-w-[540px] md:grid-cols-2">
                <label className="text-xs">
                  <div className="mb-1 text-slate-600">Repository Name</div>
                  <input
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, name: event.target.value }))}
                    value={config.name}
                  />
                </label>
                <label className="text-xs">
                  <div className="mb-1 text-slate-600">Repository Description</div>
                  <input
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(event) => setConfig((current) => ({ ...current, description: event.target.value }))}
                    value={config.description ?? ""}
                  />
                </label>
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
                <input
                  className="w-[220px] rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="Publish changelog"
                  value={commitMessage}
                />
                <button
                  className="rounded bg-emerald-700 px-3 py-1 text-sm text-white"
                  disabled={!canSave}
                  onClick={publishWorkflow}
                  type="button"
                >
                  Publish
                </button>
                <button
                  className="rounded bg-indigo-700 px-3 py-1 text-sm text-white"
                  onClick={runLatest}
                  type="button"
                >
                  Run Latest
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
              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                Last publish: {publishedWorkflowId && publishedVersion ? `${publishedWorkflowId} v${publishedVersion}` : "none"}
              </div>
            </div>
          </section>

          <section className="rounded border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">AI Builder</h3>
              <div className="flex gap-2">
                <button
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => setAiPrompt("Build an ops runbook that monitors supplier delays, summarizes impact, and asks approval before any external update.")}
                  type="button"
                >
                  Ops preset
                </button>
                <button
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => setAiPrompt("Create a research memo workflow that gathers web sources, compares options, and outputs an executive summary.")}
                  type="button"
                >
                  Research preset
                </button>
                <button
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => setAiPrompt("Create a data analysis workflow that reads DB metrics, computes trends, and requires approval before writing files.")}
                  type="button"
                >
                  Data preset
                </button>
              </div>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <label className="text-xs">
                <div className="mb-1 text-slate-600">Goal template</div>
                <select
                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setAiTemplate(event.target.value as AiTemplate)}
                  value={aiTemplate}
                >
                  <option value="ops_runbook">Ops runbook</option>
                  <option value="research_memo">Research memo</option>
                  <option value="data_analysis">Data analysis</option>
                  <option value="code_helper">Code helper</option>
                </select>
              </label>
              <label className="text-xs">
                <div className="mb-1 text-slate-600">Risk level</div>
                <select
                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setAiRiskLevel(event.target.value as AiRisk)}
                  value={aiRiskLevel}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="text-xs">
                <div className="mb-1 text-slate-600">Provider</div>
                <select
                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  onChange={(event) => setAiProvider(event.target.value as AiProvider)}
                  value={aiProvider}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
            </div>

            <label className="mt-3 block text-xs">
              <div className="mb-1 text-slate-600">Describe what you want</div>
              <textarea
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                onChange={(event) => setAiPrompt(event.target.value)}
                placeholder="I need a workflow that monitors X, summarizes Y, asks for approval before sending Z."
                rows={3}
                value={aiPrompt}
              />
            </label>

            <div className="mt-3">
              <div className="mb-1 text-xs text-slate-600">Allowed tools</div>
              <div className="flex flex-wrap gap-2">
                {AI_TOOL_CHOICES.map((tool) => (
                  <label className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs" key={tool.id}>
                    <input
                      checked={aiAllowedTools.includes(tool.id)}
                      onChange={() => toggleAiTool(tool.id)}
                      type="checkbox"
                    />
                    {tool.label}
                  </label>
                ))}
              </div>
            </div>

            <label className="mt-3 block text-xs">
              <div className="mb-1 text-slate-600">Refinement feedback</div>
              <textarea
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                onChange={(event) => setAiFeedback(event.target.value)}
                placeholder="Refine: make steps shorter and add approval only before risky actions."
                rows={2}
                value={aiFeedback}
              />
            </label>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={aiBusy}
                onClick={() => generateWithAi("generate")}
                type="button"
              >
                {aiBusy ? "Generating..." : "Generate Draft"}
              </button>
              <button
                className="rounded bg-slate-700 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={aiBusy}
                onClick={() => generateWithAi("refine")}
                type="button"
              >
                {aiBusy ? "Refining..." : "Refine"}
              </button>
            </div>

            {aiNotes.length > 0 ? (
              <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                Notes: {aiNotes.join(" | ")}
              </div>
            ) : null}
            {aiRisks.length > 0 ? (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Risks: {aiRisks.join(" | ")}
              </div>
            ) : null}
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
        </>
      )}

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </div>
  );
}
