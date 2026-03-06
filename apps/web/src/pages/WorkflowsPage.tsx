import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DevBuilder } from "../components/DevBuilder";
import { FlowBuilder } from "../components/FlowBuilder";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { WorkflowSummary } from "../lib/types";
import {
  WORKFLOW_DRAFT_STORAGE_KEY,
  createDefaultWorkflowConfig,
  validateFlowGraph,
  type WorkflowConfig,
  type WorkflowNodeType
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
    kind?: "AGENT" | "APPROVAL" | "ROUTER";
    agentName?: string;
    params?: Record<string, unknown>;
  }>;
};

type PublishPayload = {
  workflowId?: string;
  version?: number;
  sourceDraftId?: string;
  structuredContent?: {
    workflowId?: string;
    version?: number;
  };
  content?: Array<{ type?: string; text?: string }>;
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

type WorkflowSuggestion = {
  id: string;
  workflowId: string;
  authorUserId: string;
  authorUsername: string;
  authorRole: string;
  body: string;
  createdAt: string;
};

type WorkflowChangeRequest = {
  id: string;
  workflowId: string;
  title: string;
  body: string;
  status: "OPEN" | "ACCEPTED" | "REJECTED" | "MERGED";
  authorUserId: string;
  authorUsername: string;
  authorRole: string;
  proposedConfig?: WorkflowConfig | null;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
      record.kind === "AGENT" || record.kind === "APPROVAL" || record.kind === "ROUTER"
        ? (record.kind as "AGENT" | "APPROVAL" | "ROUTER")
        : undefined;
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

function normalizePublishPayload(payload: PublishPayload): { workflowId: string; version: number } {
  const directWorkflowId = typeof payload.workflowId === "string" ? payload.workflowId.trim() : "";
  const directVersion = Number(payload.version);
  if (directWorkflowId && Number.isFinite(directVersion) && directVersion > 0) {
    return { workflowId: directWorkflowId, version: directVersion };
  }

  const structuredWorkflowId =
    typeof payload.structuredContent?.workflowId === "string" ? payload.structuredContent.workflowId.trim() : "";
  const structuredVersion = Number(payload.structuredContent?.version);
  if (structuredWorkflowId && Number.isFinite(structuredVersion) && structuredVersion > 0) {
    return { workflowId: structuredWorkflowId, version: structuredVersion };
  }

  const text = payload.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { workflowId?: unknown; version?: unknown };
      const parsedWorkflowId = typeof parsed.workflowId === "string" ? parsed.workflowId.trim() : "";
      const parsedVersion = Number(parsed.version);
      if (parsedWorkflowId && Number.isFinite(parsedVersion) && parsedVersion > 0) {
        return { workflowId: parsedWorkflowId, version: parsedVersion };
      }
    } catch {
      // handled below
    }
  }

  throw new Error("Publish response missing workflowId/version.");
}

function buildGraphFromPublishedSteps(
  steps: NonNullable<WorkflowVersionDetails["steps"]>
): NonNullable<WorkflowConfig["graph"]> {
  const startId = `node_start_${Math.random().toString(36).slice(2, 8)}`;
  const nodes: NonNullable<WorkflowConfig["graph"]>["nodes"] = [
    { id: startId, type: "start", position: { x: 100, y: 180 }, config: { label: "Start" } }
  ];
  const edges: NonNullable<WorkflowConfig["graph"]>["edges"] = [];

  let previousId = startId;
  steps.forEach((step, index) => {
    const rawId = step.id && step.id.trim() ? step.id : `node_${index + 1}`;
    const nodeId = `node_${rawId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const agent = String(step.agentName ?? "").toLowerCase();
    const explicitModeRaw = String(step.params?.llmNodeMode ?? "").toLowerCase();
    const llmNodeMode =
      step.kind === "APPROVAL" || step.kind === "ROUTER"
        ? "orchestrator"
        : explicitModeRaw === "summary_llm"
          ? "summary_llm"
        : agent.includes("debate")
          ? "debate"
          : "llm";
    const nodeType: WorkflowNodeType =
      agent.includes("datasetloader")
        ? "dataset_loader"
        : agent.includes("featurebuilder")
          ? "feature_builder"
          : agent.includes("dbwrite")
            ? "db_write"
            : agent.includes("logistics") || typeof step.params?.toolId === "string"
              ? "tool"
              : agent.includes("notification")
                ? "output"
                : "llm";

    nodes.push({
      id: nodeId,
      type: nodeType,
      position: { x: 340 + index * 240, y: 180 },
      config: {
        label: step.name ?? `Step ${index + 1}`,
        ...(step.params ?? {}),
        ...(nodeType === "llm" ? { llmNodeMode } : {})
      }
    });

    edges.push({
      id: `edge_${Math.random().toString(36).slice(2, 8)}`,
      source: previousId,
      target: nodeId
    });
    previousId = nodeId;
  });

  if (!nodes.some((node) => node.type === "output")) {
    const outputId = `node_output_${Math.random().toString(36).slice(2, 8)}`;
    nodes.push({
      id: outputId,
      type: "output",
      position: { x: 340 + steps.length * 240, y: 180 },
      config: { label: "Output" }
    });
    edges.push({
      id: `edge_${Math.random().toString(36).slice(2, 8)}`,
      source: previousId,
      target: outputId
    });
  }

  return { nodes, edges };
}

export function WorkflowsPage() {
  const navigate = useNavigate();
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
  const [workflowSuggestions, setWorkflowSuggestions] = useState<WorkflowSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [newSuggestion, setNewSuggestion] = useState("");
  const [changeRequests, setChangeRequests] = useState<WorkflowChangeRequest[]>([]);
  const [changeRequestsLoading, setChangeRequestsLoading] = useState(false);
  const [changeRequestsError, setChangeRequestsError] = useState<string | null>(null);
  const [newCrTitle, setNewCrTitle] = useState("");
  const [newCrBody, setNewCrBody] = useState("");
  const [attachCurrentDraftToCr, setAttachCurrentDraftToCr] = useState(false);

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
      if (!selectedWorkflowId && workflows.length > 0) {
        setSelectedWorkflowId(workflows[0].workflowId);
      }
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : "Failed to load workflows");
    } finally {
      setWorkflowLoading(false);
    }
  }

  async function loadSuggestions(workflowId: string) {
    if (!token) {
      return;
    }
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    try {
      const payload = await apiFetch<{ suggestions: WorkflowSuggestion[] }>(
        `/workflows/${encodeURIComponent(workflowId)}/suggestions`,
        {},
        token
      );
      setWorkflowSuggestions(payload.suggestions ?? []);
    } catch (err) {
      setWorkflowSuggestions([]);
      setSuggestionsError(err instanceof Error ? err.message : "Failed to load suggestions");
    } finally {
      setSuggestionsLoading(false);
    }
  }

  async function submitSuggestion() {
    if (!token || !selectedWorkflowId) {
      return;
    }
    const body = newSuggestion.trim();
    if (!body) {
      setSuggestionsError("Suggestion cannot be empty.");
      return;
    }
    setSuggestionsError(null);
    try {
      await apiFetch(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}/suggestions`,
        {
          method: "POST",
          body: JSON.stringify({ body })
        },
        token
      );
      setNewSuggestion("");
      await loadSuggestions(selectedWorkflowId);
      setStatus("Suggestion submitted.");
    } catch (err) {
      setSuggestionsError(err instanceof Error ? err.message : "Failed to submit suggestion");
    }
  }

  async function loadChangeRequests(workflowId: string) {
    if (!token) {
      return;
    }
    setChangeRequestsLoading(true);
    setChangeRequestsError(null);
    try {
      const payload = await apiFetch<{ changeRequests: WorkflowChangeRequest[] }>(
        `/workflows/${encodeURIComponent(workflowId)}/change-requests`,
        {},
        token
      );
      setChangeRequests(payload.changeRequests ?? []);
    } catch (err) {
      setChangeRequests([]);
      setChangeRequestsError(err instanceof Error ? err.message : "Failed to load change requests");
    } finally {
      setChangeRequestsLoading(false);
    }
  }

  async function submitChangeRequest() {
    if (!token || !selectedWorkflowId) {
      return;
    }
    const title = newCrTitle.trim();
    const body = newCrBody.trim();
    if (!title || !body) {
      setChangeRequestsError("Title and description are required.");
      return;
    }
    setChangeRequestsError(null);
    try {
      await apiFetch(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}/change-requests`,
        {
          method: "POST",
          body: JSON.stringify({
            title,
            body,
            proposedConfig: attachCurrentDraftToCr ? config : null
          })
        },
        token
      );
      setNewCrTitle("");
      setNewCrBody("");
      setAttachCurrentDraftToCr(false);
      await loadChangeRequests(selectedWorkflowId);
      setStatus("Change request submitted.");
    } catch (err) {
      setChangeRequestsError(err instanceof Error ? err.message : "Failed to submit change request");
    }
  }

  async function updateChangeRequestStatus(changeRequestId: string, statusValue: "OPEN" | "ACCEPTED" | "REJECTED" | "MERGED") {
    if (!token || !selectedWorkflowId) {
      return;
    }
    try {
      await apiFetch(
        `/workflows/${encodeURIComponent(selectedWorkflowId)}/change-requests/${encodeURIComponent(changeRequestId)}/status`,
        {
          method: "POST",
          body: JSON.stringify({ status: statusValue })
        },
        token
      );
      await loadChangeRequests(selectedWorkflowId);
      setStatus(`Change request marked ${statusValue}.`);
    } catch (err) {
      setChangeRequestsError(err instanceof Error ? err.message : "Failed to update change request status");
    }
  }

  function pullChangeRequestToBuilder(changeRequest: WorkflowChangeRequest) {
    if (!changeRequest.proposedConfig) {
      setChangeRequestsError("This change request has no attached workflow config.");
      return;
    }
    const nextConfig = {
      ...changeRequest.proposedConfig,
      id: selectedWorkflowId ?? changeRequest.workflowId
    };
    setConfig(nextConfig);
    setActiveRepoId(nextConfig.id);
    setBuilderUnlocked(true);
    setPageMode("builder");
    setMode("flowchart");
    setStatus(`Pulled change request "${changeRequest.title}" into Builder draft.`);
    setError(null);
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

  async function openWorkflowInBuilder(workflow: WorkflowSummary) {
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
      let serverDetail: WorkflowVersionDetails | null = null;
      if (token) {
        try {
          const payload = await apiFetch<unknown>(`/workflows/${nextRepoId}`, {}, token);
          serverDetail = normalizeWorkflowVersionDetails(payload);
        } catch {
          serverDetail = null;
        }
      }

      const base = createDefaultWorkflowConfig();
      if (serverDetail?.steps && serverDetail.steps.length > 0) {
        nextConfig = {
          ...base,
          id: nextRepoId,
          name: serverDetail.name ?? workflow.name,
          description: serverDetail.description ?? workflow.description ?? "",
          graph: buildGraphFromPublishedSteps(serverDetail.steps)
        };
      } else {
        nextConfig = {
          ...base,
          id: nextRepoId,
          name: workflow.name,
          description: workflow.description ?? ""
        };
      }
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
    if (!selectedWorkflowId || !token) {
      setWorkflowSuggestions([]);
      setChangeRequests([]);
      return;
    }
    loadSuggestions(selectedWorkflowId).catch(() => undefined);
    loadChangeRequests(selectedWorkflowId).catch(() => undefined);
  }, [selectedWorkflowId, token]);

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
    if (!token) {
      throw new Error("Authentication token missing. Please sign in again.");
    }

    if (!canSave) {
      throw new Error("Only BUILDER or ADMIN role can save draft to API.");
    }

    if (!graphValidation.valid) {
      throw new Error(graphValidation.errors.join(" "));
    }

    const draftId =
      (typeof config.id === "string" && config.id.trim()) ||
      (typeof activeRepoId === "string" && activeRepoId.trim()) ||
      `wf_${Math.random().toString(36).slice(2, 10)}`;
    const nextConfig: WorkflowConfig = {
      ...config,
      id: draftId,
      name: config.name || draftId,
      graph: config.graph ?? { nodes: [], edges: [] }
    };

    setConfig(nextConfig);
    if (!activeRepoId) {
      setActiveRepoId(draftId);
    }
    window.localStorage.setItem(repoDraftStorageKey(draftId), JSON.stringify(nextConfig));

    return apiFetch<{ draft: DraftPayload }>(
      "/workflows/draft",
      {
        method: "POST",
        body: JSON.stringify({
          id: draftId,
          name: nextConfig.name,
          config: nextConfig
        })
      },
      token
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

      const workflowId = typeof saved.draft.id === "string" ? saved.draft.id.trim() : "";
      if (!workflowId) {
        throw new Error("Draft saved but returned empty id. Please retry save.");
      }

      setConfig((current) => ({ ...current, id: workflowId }));
      setActiveRepoId(workflowId);

      const payload = await apiFetch<PublishPayload>(
        `/workflows/draft/${encodeURIComponent(workflowId)}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            changelog: commitMessage.trim() || "Publish draft"
          })
        },
        token ?? undefined
      );
      const normalizedPublish = normalizePublishPayload(payload);

      const normalizedConfig: WorkflowConfig = {
        ...config,
        id: normalizedPublish.workflowId
      };
      setConfig(normalizedConfig);
      setActiveRepoId(normalizedPublish.workflowId);
      setSelectedWorkflowId(normalizedPublish.workflowId);
      setPublishedWorkflowId(normalizedPublish.workflowId);
      setPublishedVersion(normalizedPublish.version);
      window.localStorage.setItem(repoDraftStorageKey(normalizedPublish.workflowId), JSON.stringify(normalizedConfig));

      await loadWorkflows();
      setStatus(`Published workflow ${normalizedPublish.workflowId} v${normalizedPublish.version}.`);
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
      navigate(`/run?runId=${encodeURIComponent(payload.run.runId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  async function runInWarRoom(draftOverride?: WorkflowConfig) {
    setStatus(null);
    setError(null);

    try {
      if (!token) {
        setError("Authentication token missing. Please sign in again.");
        return;
      }
      const workflowId = publishedWorkflowId ?? activeRepoId ?? draftOverride?.id;
      if (!workflowId) {
        setError("Publish or select a workflow before launching War Room.");
        return;
      }
      const params = new URLSearchParams();
      params.set("workflowId", workflowId);
      if (publishedVersion) {
        params.set("workflowVersion", String(publishedVersion));
      }
      navigate(`/war-room-loading?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch War Room run");
    }
  }

  async function deleteActiveRepository() {
    setStatus(null);
    setError(null);

    if (!canSave) {
      setError("Only BUILDER or ADMIN role can delete a repository.");
      return;
    }

    if (!activeRepoId) {
      setError("Open a repository in Builder before deleting.");
      return;
    }

    const confirmDelete = window.confirm(
      `Delete repository "${config.name || activeRepoId}"? This will remove all published versions.`
    );
    if (!confirmDelete) {
      return;
    }

    try {
      await apiFetch<{ ok: boolean; workflowId: string; name?: string | null; deletedVersions: number }>(
        `/workflows/${encodeURIComponent(activeRepoId)}`,
        { method: "DELETE" },
        token ?? undefined
      );

      window.localStorage.removeItem(repoDraftStorageKey(activeRepoId));
      setConfig(createDefaultWorkflowConfig());
      setActiveRepoId(null);
      setSelectedWorkflowId(null);
      setExpandedWorkflowId(null);
      setBuilderUnlocked(false);
      setPageMode("dashboard");
      setPublishedWorkflowId(null);
      setPublishedVersion(null);
      await loadWorkflows();
      setStatus(`Deleted repository ${config.name || activeRepoId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete repository");
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
            <h2 className="text-base font-semibold text-black">Workflows</h2>
            <p className="text-xs text-slate-500">
              Dashboard lists all saved workflows. Builder edits your draft graph and config.
            </p>
          </div>
          <div className="flex items-center gap-2">
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
              className={`rounded px-3 py-1 text-sm ${pageMode === "dashboard" ? "bg-accent text-white" : "bg-slate-100"}`}
              onClick={() => setPageMode("dashboard")}
              type="button"
            >
              Dashboard
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
                Repository preview: {user?.teamId ?? "team"}/{newRepositoryName.trim() || "repo-name"}
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
                            selectedWorkflowId === workflow.workflowId ? "bg-orange-50" : "hover:bg-slate-50"
                          }`}
                          onClick={() => setSelectedWorkflowId(workflow.workflowId)}
                          onDoubleClick={() => {
                            openWorkflowInBuilder(workflow).catch((err) => {
                              const message = err instanceof Error ? err.message : "Failed to open workflow in builder";
                              setError(message);
                            });
                          }}
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
                                樹?
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
          <section className="rounded border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Workflow Suggestions</h3>
              <div className="text-xs text-slate-500">
                {selectedWorkflowId ? `Workflow: ${selectedWorkflowId}` : "Select a workflow to view suggestions"}
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Share issues, gaps, and improvement ideas. Builders can use this as a fix backlog.
            </p>
            <div className="mt-3">
              <textarea
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                onChange={(event) => setNewSuggestion(event.target.value)}
                placeholder="Example: Add approval gate before DB Write when confidence < 0.7."
                rows={3}
                value={newSuggestion}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!selectedWorkflowId}
                  onClick={() => submitSuggestion().catch(() => undefined)}
                  type="button"
                >
                  Submit Suggestion
                </button>
                <button
                  className="rounded border border-slate-300 px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!selectedWorkflowId}
                  onClick={() => (selectedWorkflowId ? loadSuggestions(selectedWorkflowId).catch(() => undefined) : undefined)}
                  type="button"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {suggestionsLoading ? <p className="text-xs text-slate-500">Loading suggestions...</p> : null}
              {suggestionsError ? <p className="text-xs text-warn">{suggestionsError}</p> : null}
              {!suggestionsLoading && workflowSuggestions.length === 0 ? (
                <p className="text-sm text-slate-500">No suggestions yet.</p>
              ) : null}
              {workflowSuggestions.map((item) => (
                <article className="rounded border border-slate-200 bg-slate-50 p-3" key={item.id}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span className="font-medium text-slate-800">{item.authorUsername}</span>
                    <span className="rounded bg-slate-200 px-1.5 py-0.5">{item.authorRole}</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{item.body}</div>
                </article>
              ))}
            </div>
          </section>
          <section className="rounded border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Workflow Change Requests (PR-style)</h3>
              <div className="text-xs text-slate-500">
                {selectedWorkflowId ? `Workflow: ${selectedWorkflowId}` : "Select a workflow to submit requests"}
              </div>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Create request tickets with optional proposed workflow config. Builders/Admins can pull proposals into Builder and merge.
            </p>
            <div className="mt-3 grid gap-2">
              <input
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                onChange={(event) => setNewCrTitle(event.target.value)}
                placeholder="Title: Add approval gate before DB write"
                value={newCrTitle}
              />
              <textarea
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                onChange={(event) => setNewCrBody(event.target.value)}
                placeholder="Describe what should change and why."
                rows={3}
                value={newCrBody}
              />
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  checked={attachCurrentDraftToCr}
                  onChange={(event) => setAttachCurrentDraftToCr(event.target.checked)}
                  type="checkbox"
                />
                Attach current Builder draft as proposed config
              </label>
              <div className="flex items-center gap-2">
                <button
                  className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!selectedWorkflowId}
                  onClick={() => submitChangeRequest().catch(() => undefined)}
                  type="button"
                >
                  Create Change Request
                </button>
                <button
                  className="rounded border border-slate-300 px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!selectedWorkflowId}
                  onClick={() => (selectedWorkflowId ? loadChangeRequests(selectedWorkflowId).catch(() => undefined) : undefined)}
                  type="button"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {changeRequestsLoading ? <p className="text-xs text-slate-500">Loading change requests...</p> : null}
              {changeRequestsError ? <p className="text-xs text-warn">{changeRequestsError}</p> : null}
              {!changeRequestsLoading && changeRequests.length === 0 ? (
                <p className="text-sm text-slate-500">No change requests yet.</p>
              ) : null}
              {changeRequests.map((item) => (
                <article className="rounded border border-slate-200 bg-slate-50 p-3" key={item.id}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-800">{item.title}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 ${
                        item.status === "OPEN"
                          ? "bg-amber-100 text-amber-800"
                          : item.status === "ACCEPTED"
                            ? "bg-emerald-100 text-emerald-800"
                            : item.status === "MERGED"
                              ? "bg-cyan-100 text-cyan-800"
                              : "bg-rose-100 text-rose-800"
                      }`}
                    >
                      {item.status}
                    </span>
                    <span className="text-slate-600">{item.authorUsername}</span>
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">{item.authorRole}</span>
                    <span className="text-slate-500">{formatDateTime(item.createdAt)}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{item.body}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canSave && item.proposedConfig ? (
                      <button
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        onClick={() => pullChangeRequestToBuilder(item)}
                        type="button"
                      >
                        Pull To Builder Draft
                      </button>
                    ) : null}
                    {canSave ? (
                      <>
                        <button
                          className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800"
                          onClick={() => updateChangeRequestStatus(item.id, "ACCEPTED").catch(() => undefined)}
                          type="button"
                        >
                          Accept
                        </button>
                        <button
                          className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-800"
                          onClick={() => updateChangeRequestStatus(item.id, "REJECTED").catch(() => undefined)}
                          type="button"
                        >
                          Reject
                        </button>
                        <button
                          className="rounded border border-cyan-300 bg-cyan-50 px-2 py-1 text-xs text-cyan-800"
                          onClick={() => updateChangeRequestStatus(item.id, "MERGED").catch(() => undefined)}
                          type="button"
                        >
                          Mark Merged
                        </button>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="rounded border border-slate-200 bg-white p-2">
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr),340px]">
              <div className="min-w-0">
                {mode === "flowchart" ? (
                  <FlowBuilder config={config} onConfigChange={setConfig} />
                ) : (
                  <DevBuilder config={config} onConfigChange={setConfig} />
                )}
              </div>

              <aside className="space-y-3 xl:sticky xl:top-3">
                <section className="rounded border border-slate-700 bg-slate-900 p-2 text-slate-100">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold tracking-wide text-slate-300">Workflow Studio</span>
                    <div className="flex items-center overflow-hidden rounded border border-slate-600">
                      <button
                        className={`px-2 py-1 text-[11px] ${mode === "flowchart" ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300"}`}
                        onClick={() => setMode("flowchart")}
                        type="button"
                      >
                        Flow
                      </button>
                      <button
                        className={`border-l border-slate-600 px-2 py-1 text-[11px] ${mode === "developer" ? "bg-orange-600 text-white" : "bg-slate-800 text-slate-300"}`}
                        onClick={() => setMode("developer")}
                        type="button"
                      >
                        Dev
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <input
                      className="h-7 w-full rounded border border-slate-600 bg-slate-800 px-2 text-xs text-slate-100"
                      onChange={(event) => setConfig((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Repository name"
                      value={config.name}
                    />
                    <input
                      className="h-7 w-full rounded border border-slate-600 bg-slate-800 px-2 text-xs text-slate-100"
                      onChange={(event) => setConfig((current) => ({ ...current, description: event.target.value }))}
                      placeholder="Description"
                      value={config.description ?? ""}
                    />
                    <input
                      className="h-7 w-full rounded border border-slate-600 bg-slate-800 px-2 text-xs text-slate-100"
                      onChange={(event) => setCommitMessage(event.target.value)}
                      placeholder="Publish changelog"
                      value={commitMessage}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className="rounded border border-slate-500 bg-slate-800 px-2 py-1 text-xs"
                        onClick={resetDraft}
                        type="button"
                      >
                        Reset
                      </button>
                      <button
                        className="rounded border border-slate-500 bg-slate-800 px-2 py-1 text-xs"
                        disabled={!canSave}
                        onClick={saveDraft}
                        type="button"
                      >
                        Save
                      </button>
                      <button
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                        disabled={!canSave}
                        onClick={publishWorkflow}
                        type="button"
                      >
                        Publish
                      </button>
                      <button
                        className="rounded bg-orange-700 px-2 py-1 text-xs font-medium text-white"
                        onClick={runLatest}
                        type="button"
                      >
                        Run Latest
                      </button>
                      <button
                        className="col-span-2 rounded bg-orange-600 px-2 py-1 text-xs font-medium text-white"
                        onClick={() => {
                          runInWarRoom().catch((err) => {
                            setError(err instanceof Error ? err.message : "Failed to launch War Room run");
                          });
                        }}
                        type="button"
                      >
                        Run in War Room
                      </button>
                      <button
                        className="col-span-2 rounded bg-rose-700 px-2 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!canSave || !activeRepoId}
                        onClick={() => {
                          deleteActiveRepository().catch((err) => {
                            setError(err instanceof Error ? err.message : "Failed to delete repository");
                          });
                        }}
                        type="button"
                      >
                        Delete Repository
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 text-[11px]">
                      <span className={`rounded px-2 py-0.5 ${graphValidation.valid ? "bg-emerald-800" : "bg-rose-800"}`}>
                        {graphValidation.valid ? "Graph OK" : "Graph Invalid"}
                      </span>
                      <span className="rounded bg-slate-800 px-2 py-0.5">Draft: {serverDraftUpdatedAt ?? "none"}</span>
                      <span className="rounded bg-slate-800 px-2 py-0.5">
                        Pub: {publishedWorkflowId && publishedVersion ? `v${publishedVersion}` : "none"}
                      </span>
                    </div>
                    {!graphValidation.valid ? (
                      <div className="rounded bg-rose-900/70 px-2 py-1 text-[11px] text-rose-100">
                        {graphValidation.errors.join(" ")}
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="rounded border border-slate-300 bg-slate-100 p-2">
                  <div className="mb-2 text-xs font-semibold text-slate-700">AI Copilot</div>
                  <div className="grid grid-cols-3 gap-1">
                    <select
                      className="h-7 rounded border border-slate-300 bg-white px-2 text-xs"
                      onChange={(event) => setAiTemplate(event.target.value as AiTemplate)}
                      value={aiTemplate}
                    >
                      <option value="ops_runbook">Ops</option>
                      <option value="research_memo">Research</option>
                      <option value="data_analysis">Data</option>
                      <option value="code_helper">Code</option>
                    </select>
                    <select
                      className="h-7 rounded border border-slate-300 bg-white px-2 text-xs"
                      onChange={(event) => setAiRiskLevel(event.target.value as AiRisk)}
                      value={aiRiskLevel}
                    >
                      <option value="low">Risk Low</option>
                      <option value="medium">Risk Med</option>
                      <option value="high">Risk High</option>
                    </select>
                    <select
                      className="h-7 rounded border border-slate-300 bg-white px-2 text-xs"
                      onChange={(event) => setAiProvider(event.target.value as AiProvider)}
                      value={aiProvider}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Gemini</option>
                    </select>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {AI_TOOL_CHOICES.map((tool) => (
                      <button
                        className={`rounded border px-2 py-1 text-[11px] ${
                          aiAllowedTools.includes(tool.id)
                            ? "border-orange-600 bg-orange-50 text-orange-800"
                            : "border-slate-300 bg-white text-slate-600"
                        }`}
                        key={tool.id}
                        onClick={() => toggleAiTool(tool.id)}
                        type="button"
                      >
                        {tool.label}
                      </button>
                    ))}
                  </div>
                  <input
                    className="mt-2 h-8 w-full rounded border border-slate-300 px-2 text-xs"
                    onChange={(event) => setAiPrompt(event.target.value)}
                    placeholder="Describe workflow intent..."
                    value={aiPrompt}
                  />
                  <input
                    className="mt-2 h-8 w-full rounded border border-slate-300 px-2 text-xs"
                    onChange={(event) => setAiFeedback(event.target.value)}
                    placeholder="Refinement feedback..."
                    value={aiFeedback}
                  />
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      className="rounded bg-slate-900 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={aiBusy}
                      onClick={() => generateWithAi("generate")}
                      type="button"
                    >
                      {aiBusy ? "Generating..." : "Generate"}
                    </button>
                    <button
                      className="rounded bg-slate-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={aiBusy}
                      onClick={() => generateWithAi("refine")}
                      type="button"
                    >
                      {aiBusy ? "Refining..." : "Refine"}
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1">
                    <button
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                      onClick={() =>
                        setAiPrompt("Build an ops runbook that monitors supplier delays, summarizes impact, and asks approval before any external update.")
                      }
                      type="button"
                    >
                      Ops
                    </button>
                    <button
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                      onClick={() =>
                        setAiPrompt("Create a research memo workflow that gathers web sources, compares options, and outputs an executive summary.")
                      }
                      type="button"
                    >
                      Research
                    </button>
                    <button
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                      onClick={() =>
                        setAiPrompt("Create a data analysis workflow that reads DB metrics, computes trends, and requires approval before writing files.")
                      }
                      type="button"
                    >
                      Data
                    </button>
                  </div>
                  {aiNotes.length > 0 || aiRisks.length > 0 ? (
                    <div className="mt-2 space-y-1 text-[11px]">
                      {aiNotes.length > 0 ? (
                        <div className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700">Notes: {aiNotes.join(" | ")}</div>
                      ) : null}
                      {aiRisks.length > 0 ? (
                        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">Risks: {aiRisks.join(" | ")}</div>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <details className="rounded border border-slate-200 bg-white p-2">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">Draft JSON</summary>
                  <pre className="mt-2 max-h-[240px] overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">
                    {JSON.stringify(config, null, 2)}
                  </pre>
                </details>
              </aside>
            </div>
          </section>
        </>
      )}

      {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      {error ? <p className="text-sm text-warn">{error}</p> : null}
    </div>
  );
}



