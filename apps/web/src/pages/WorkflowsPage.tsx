import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { WorkflowStep, WorkflowSummary } from "../lib/types";

type AgentEntry = {
  name: string;
  type: string;
  description: string;
};

type WorkflowDetail = {
  workflowId: string;
  name: string;
  description?: string;
  version: number;
  steps: WorkflowStep[];
};

type EditableStep = {
  id: string;
  name: string;
  kind: "AGENT" | "APPROVAL";
  agentName?: string;
  paramsJson: string;
};

export function WorkflowsPage() {
  const { token, user } = useAuth();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [proposals, setProposals] = useState<Array<{ id: string; title: string; createdAt: string }>>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [changelog, setChangelog] = useState("Initial draft");
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canBuild = user?.role === "BUILDER";
  const canRun = user?.role === "OPERATOR";

  const taskAgents = useMemo(
    () => agents.filter((agent) => agent.type === "TASK"),
    [agents]
  );

  async function loadWorkflows() {
    const payload = await apiFetch<{ workflows: WorkflowSummary[] }>("/workflows", {}, token ?? undefined);
    setWorkflows(payload.workflows);
  }

  async function loadAgents() {
    const payload = await apiFetch<{ agents: AgentEntry[] }>("/agents", {}, token ?? undefined);
    setAgents(payload.agents);
  }

  async function loadProposals() {
    const payload = await apiFetch<{ proposals: Array<{ id: string; title: string; createdAt: string }> }>(
      "/optimization/proposals",
      {},
      token ?? undefined
    );
    setProposals(payload.proposals);
  }

  async function loadWorkflow(workflowId: string) {
    const payload = await apiFetch<WorkflowDetail>(`/workflows/${workflowId}`, {}, token ?? undefined);
    setSelectedWorkflowId(payload.workflowId);
    setSelectedVersion(payload.version);
    setName(payload.name);
    setDescription(payload.description ?? "");
    setSteps(
      payload.steps.map((step) => ({
        id: step.id,
        name: step.name,
        kind: step.kind,
        agentName: step.agentName,
        paramsJson: JSON.stringify(step.params ?? {}, null, 2)
      }))
    );
  }

  useEffect(() => {
    if (!token) {
      return;
    }

    loadWorkflows().catch(console.error);
    loadAgents().catch(console.error);
    loadProposals().catch(console.error);
  }, [token]);

  function resetEditor() {
    setSelectedWorkflowId(null);
    setSelectedVersion(null);
    setName("New Workflow");
    setDescription("");
    setSteps([]);
    setChangelog("Initial version");
  }

  function parseSteps(): WorkflowStep[] {
    return steps.map((step) => ({
      id: step.id,
      name: step.name,
      kind: step.kind,
      agentName: step.kind === "AGENT" ? step.agentName : undefined,
      params: JSON.parse(step.paramsJson || "{}")
    }));
  }

  async function saveWorkflow() {
    setStatus(null);
    setError(null);

    try {
      const parsedSteps = parseSteps();
      if (selectedWorkflowId) {
        await apiFetch(
          `/workflows/${selectedWorkflowId}/versions`,
          {
            method: "POST",
            body: JSON.stringify({
              name,
              description,
              changelog,
              steps: parsedSteps
            })
          },
          token ?? undefined
        );
      } else {
        await apiFetch(
          "/workflows",
          {
            method: "POST",
            body: JSON.stringify({
              name,
              description,
              changelog,
              steps: parsedSteps
            })
          },
          token ?? undefined
        );
      }

      setStatus("Workflow saved");
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workflow");
    }
  }

  async function forkWorkflow() {
    if (!selectedWorkflowId) {
      return;
    }

    try {
      await apiFetch(
        `/workflows/${selectedWorkflowId}/fork`,
        {
          method: "POST",
          body: JSON.stringify({
            name: `${name} Fork`,
            changelog: "Forked workflow"
          })
        },
        token ?? undefined
      );
      setStatus("Workflow forked");
      await loadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fork workflow");
    }
  }

  async function runWorkflow() {
    if (!selectedWorkflowId) {
      return;
    }

    try {
      await apiFetch(
        "/runs",
        {
          method: "POST",
          body: JSON.stringify({
            workflowId: selectedWorkflowId,
            workflowVersion: selectedVersion ?? undefined
          })
        },
        token ?? undefined
      );
      setStatus("Run started");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
      <section className="rounded border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Workflow Repo</h2>
          {canBuild ? (
            <button className="rounded bg-slate-800 px-2 py-1 text-xs text-white" onClick={resetEditor}>
              New
            </button>
          ) : null}
        </div>
        <div className="space-y-2">
          {workflows.map((workflow) => (
            <button
              className={`w-full rounded border px-3 py-2 text-left text-sm ${
                selectedWorkflowId === workflow.workflowId
                  ? "border-accent bg-cyan-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
              key={workflow.workflowId}
              onClick={() => loadWorkflow(workflow.workflowId)}
              type="button"
            >
              <div className="font-medium">{workflow.name}</div>
              <div className="text-xs text-slate-500">v{workflow.latestVersion}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <div className="mb-1 text-slate-700">Workflow name</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>

          <label className="text-sm">
            <div className="mb-1 text-slate-700">Changelog message</div>
            <input
              className="w-full rounded border border-slate-300 px-2 py-1"
              onChange={(event) => setChangelog(event.target.value)}
              value={changelog}
            />
          </label>
        </div>

        <label className="text-sm">
          <div className="mb-1 text-slate-700">Description</div>
          <textarea
            className="w-full rounded border border-slate-300 px-2 py-1"
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            value={description}
          />
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Builder Steps</h3>
            {canBuild ? (
              <div className="flex gap-2">
                <button
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => {
                    const firstAgent = taskAgents[0]?.name;
                    setSteps((current) => [
                      ...current,
                      {
                        id: `step-${current.length + 1}`,
                        name: `Task ${current.length + 1}`,
                        kind: "AGENT",
                        agentName: firstAgent,
                        paramsJson: "{}"
                      }
                    ]);
                  }}
                  type="button"
                >
                  Add Agent Step
                </button>
                <button
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  onClick={() => {
                    setSteps((current) => [
                      ...current,
                      {
                        id: `approval-${current.length + 1}`,
                        name: `Approval ${current.length + 1}`,
                        kind: "APPROVAL",
                        paramsJson: '{"reason":"Manual approval"}'
                      }
                    ]);
                  }}
                  type="button"
                >
                  Add Approval Node
                </button>
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <div className="rounded border border-slate-200 p-3" key={step.id}>
                <div className="grid gap-2 md:grid-cols-4">
                  <input
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(event) => {
                      const next = [...steps];
                      next[index].id = event.target.value;
                      setSteps(next);
                    }}
                    value={step.id}
                  />
                  <input
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(event) => {
                      const next = [...steps];
                      next[index].name = event.target.value;
                      setSteps(next);
                    }}
                    value={step.name}
                  />
                  <select
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                    onChange={(event) => {
                      const next = [...steps];
                      next[index].kind = event.target.value as "AGENT" | "APPROVAL";
                      if (next[index].kind === "APPROVAL") {
                        next[index].agentName = undefined;
                      }
                      setSteps(next);
                    }}
                    value={step.kind}
                  >
                    <option value="AGENT">AGENT</option>
                    <option value="APPROVAL">APPROVAL</option>
                  </select>

                  {step.kind === "AGENT" ? (
                    <select
                      className="rounded border border-slate-300 px-2 py-1 text-sm"
                      onChange={(event) => {
                        const next = [...steps];
                        next[index].agentName = event.target.value;
                        setSteps(next);
                      }}
                      value={step.agentName}
                    >
                      {taskAgents.map((agent) => (
                        <option key={agent.name} value={agent.name}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="rounded border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-500">
                      Approval node
                    </div>
                  )}
                </div>

                <textarea
                  className="mt-2 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                  onChange={(event) => {
                    const next = [...steps];
                    next[index].paramsJson = event.target.value;
                    setSteps(next);
                  }}
                  rows={3}
                  value={step.paramsJson}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accentDark"
            disabled={!canBuild}
            onClick={saveWorkflow}
            type="button"
          >
            Save Version
          </button>
          <button
            className="rounded border border-slate-300 px-3 py-2 text-sm"
            disabled={!canBuild || !selectedWorkflowId}
            onClick={forkWorkflow}
            type="button"
          >
            Fork Workflow
          </button>
          <button
            className="rounded border border-slate-300 px-3 py-2 text-sm"
            disabled={!canRun || !selectedWorkflowId}
            onClick={runWorkflow}
            type="button"
          >
            Save + Run
          </button>
        </div>

        {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
        {error ? <p className="text-sm text-warn">{error}</p> : null}

        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <h3 className="text-sm font-semibold">Optimization Agent Proposals</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {proposals.slice(0, 5).map((proposal) => (
              <li key={proposal.id}>
                {proposal.title} <span className="text-xs text-slate-500">({proposal.createdAt})</span>
              </li>
            ))}
            {proposals.length === 0 ? <li className="text-slate-500">No proposals yet.</li> : null}
          </ul>
        </div>
      </section>
    </div>
  );
}