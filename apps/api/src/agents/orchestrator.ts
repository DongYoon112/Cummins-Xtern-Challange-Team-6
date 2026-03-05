import { randomUUID } from "node:crypto";
import type { RunState, RunStepState, WorkflowStep } from "@agentfoundry/shared";
import { RunStateSchema } from "@agentfoundry/shared";
import { db } from "../lib/db";
import { callMcpTool } from "../lib/mcpClient";
import { getTeamSettingsForServer } from "../lib/settings";
import { evaluateRouteCondition, resolveTemplates, setValueByPath } from "../lib/template";
import { runPolicyInputCheck, runPolicyOutputCheck } from "./policyAgent";
import { runTaskAgent } from "./taskAgents";
import { runVerifier } from "./verifierAgent";
import { createOptimizationProposal } from "./optimizationAgent";

type AgentCatalogRow = { name: string; allowlist: string[] };
type RunActor = { userId: string; username: string; teamId: string };
type ApprovalRow = {
  id: string;
  team_id: string;
  run_id: string;
  workflow_id: string;
  step_id: string;
  step_name: string;
  kind: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  context_json: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
};

type RuntimeContext = {
  runId: string;
  workflowId: string;
  userId: string;
  variables: Record<string, unknown>;
  steps: Record<string, { status: string; output?: unknown; startedAt?: string; endedAt?: string }>;
  lastOutput?: unknown;
};

type TaskResult = {
  output: Record<string, unknown>;
  confidence: number;
  rationale: string;
  toolCalls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  mockMode: boolean;
};

type RouterDecisionRecord = {
  id: string;
  runId: string;
  workflowId: string;
  routerStepId: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decision?: "approve" | "reject" | null;
  requestedAt: string;
  decidedAt?: string | null;
};

function isLikelyWriteSql(query: string) {
  return /(^|\s)(insert|update|delete|create|alter|drop|truncate|replace)(\s|$)/i.test(query.trim());
}

function redactConnectionTarget(connectionString: string) {
  return connectionString ? connectionString.replace(/:\/\/[^@]+@/, "://***@") : "";
}

export class OrchestratorService {
  private allowlists = new Map<string, string[]>();

  private async refreshAllowlists() {
    const payload = await callMcpTool<{ includeDisabled?: boolean }, { agents: AgentCatalogRow[] }>(
      "registry",
      "list_agents",
      {}
    );
    this.allowlists.clear();
    for (const agent of payload.agents) {
      this.allowlists.set(agent.name, agent.allowlist);
    }
  }

  private canCall(agentName: string, server: "registry" | "store" | "audit", tool: string) {
    const allowlist = this.allowlists.get(agentName) ?? [];
    return allowlist.includes(`${server}.${tool}`);
  }

  private ensureRuntimeContext(run: RunState): RuntimeContext {
    const current = (run.context ?? {}) as Record<string, unknown>;
    if (!current.variables || typeof current.variables !== "object" || Array.isArray(current.variables)) {
      current.variables = {};
    }
    if (!current.steps || typeof current.steps !== "object" || Array.isArray(current.steps)) {
      current.steps = {};
    }
    current.runId = run.runId;
    current.workflowId = run.workflowId;
    if (!current.userId) {
      current.userId = run.createdBy;
    }
    run.context = current;
    return current as unknown as RuntimeContext;
  }

  private refreshContextFromStep(run: RunState, step: RunStepState) {
    const context = this.ensureRuntimeContext(run);
    context.steps[step.stepId] = {
      status: step.status,
      output: step.output,
      startedAt: context.steps[step.stepId]?.startedAt ?? new Date().toISOString(),
      endedAt: step.status === "COMPLETED" || step.status === "REJECTED" ? new Date().toISOString() : undefined
    };
    if (step.output !== undefined) {
      context.lastOutput = step.output;
    }
  }

  private getStepIndexById(run: RunState, stepId?: string) {
    if (!stepId) {
      return -1;
    }
    return run.steps.findIndex((candidate) => candidate.stepId === stepId);
  }

  private resolveStepParams(step: RunStepState, context: RuntimeContext) {
    return resolveTemplates(step.params, context as unknown as Record<string, unknown>);
  }

  private async appendAudit(params: {
    userId: string;
    teamId: string;
    runId: string;
    workflowId: string;
    stepId: string;
    agentName: string;
    inputs: Record<string, unknown>;
    output: unknown;
    confidence: number;
    rationale: string;
    toolCalls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  }) {
    await callMcpTool("audit", "append_record", {
      record: {
        id: `audit_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        userId: params.userId,
        teamId: params.teamId,
        runId: params.runId,
        workflowId: params.workflowId,
        stepId: params.stepId,
        agentName: params.agentName,
        inputs: params.inputs,
        output: params.output,
        confidence: params.confidence,
        rationale: params.rationale,
        toolCalls: params.toolCalls
      }
    });
  }

  private async callMcpAsAgent<TArgs extends Record<string, unknown>, TResult>(params: {
    agentName: string;
    userId: string;
    teamId: string;
    runId: string;
    workflowId: string;
    stepId: string;
    server: "registry" | "store" | "audit";
    tool: string;
    args: TArgs;
  }): Promise<TResult> {
    const { agentName, userId, teamId, runId, workflowId, stepId, server, tool, args } = params;
    if (!this.canCall(agentName, server, tool)) {
      await this.appendAudit({
        userId,
        teamId,
        runId,
        workflowId,
        stepId,
        agentName: "Policy/Governance Agent",
        inputs: { attemptedBy: agentName, server, tool, args },
        output: { allowed: false },
        confidence: 1,
        rationale: `Blocked MCP tool call ${server}.${tool} for ${agentName} because it is not in allowlist.`,
        toolCalls: []
      });
      throw new Error(`Allowlist violation: ${agentName} cannot call ${server}.${tool}`);
    }
    return callMcpTool<TArgs, TResult>(server, tool, args);
  }

  private async persistRun(run: RunState, actor: RunActor) {
    run.updatedAt = new Date().toISOString();
    await this.callMcpAsAgent<{ run: RunState }, { run: RunState }>({
      agentName: "Orchestrator Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "run-state",
      server: "store",
      tool: "upsert_run_state",
      args: { run }
    });
  }

  private async emitWarRoomEvent(
    actor: RunActor,
    params: {
      runId: string;
      workflowId: string;
      stepId?: string;
      type: "AGENT_ALERT" | "DEBATE_RESULT" | "ROUTER_DECISION_REQUIRED" | "WORKFLOW_STATUS_UPDATE";
      payload: Record<string, unknown>;
      timestamp?: string;
    }
  ) {
    await this.callMcpAsAgent<
      {
        runId: string;
        workflowId: string;
        stepId?: string;
        type: "AGENT_ALERT" | "DEBATE_RESULT" | "ROUTER_DECISION_REQUIRED" | "WORKFLOW_STATUS_UPDATE";
        payload: Record<string, unknown>;
        timestamp?: string;
      },
      { id: number }
    >({
      agentName: "Orchestrator Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: params.runId,
      workflowId: params.workflowId,
      stepId: params.stepId ?? "war-room",
      server: "store",
      tool: "append_run_event",
      args: params
    });
  }

  private async upsertStepSnapshot(
    actor: RunActor,
    run: RunState,
    step: RunStepState,
    timestamps: { startedAt?: string; finishedAt?: string } = {}
  ) {
    await this.callMcpAsAgent<
      {
        runId: string;
        workflowId: string;
        stepId: string;
        stepName: string;
        stepKind: string;
        agentName?: string;
        status: RunStepState["status"];
        output?: unknown;
        confidence?: number;
        rationale?: string;
        startedAt?: string;
        finishedAt?: string;
      },
      { ok: true }
    >({
      agentName: "Orchestrator Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: step.stepId,
      server: "store",
      tool: "upsert_run_step",
      args: {
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        stepName: step.name,
        stepKind: step.kind,
        agentName: step.agentName,
        status: step.status,
        output: step.output,
        confidence: step.confidence,
        rationale: step.rationale,
        startedAt: timestamps.startedAt,
        finishedAt: timestamps.finishedAt
      }
    });
  }

  private async createRouterDecision(actor: RunActor, run: RunState, step: RunStepState): Promise<RouterDecisionRecord> {
    const result = await this.callMcpAsAgent<
      { runId: string; workflowId: string; routerStepId: string },
      { decision: RouterDecisionRecord }
    >({
      agentName: "Orchestrator Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: step.stepId,
      server: "store",
      tool: "create_router_decision",
      args: {
        runId: run.runId,
        workflowId: run.workflowId,
        routerStepId: step.stepId
      }
    });

    return result.decision;
  }

  private requestApproval(params: {
    run: RunState;
    step: RunStepState;
    stepIndex: number;
    actor: RunActor;
    kind: "APPROVAL_NODE" | "POLICY_GATE";
    reason: string;
    context: Record<string, unknown>;
  }): string {
    const approvalId = `apr_${randomUUID()}`;
    db.prepare(
      `
      INSERT INTO approvals (id, team_id, run_id, workflow_id, step_id, step_name, kind, status, context_json, requested_by, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      approvalId,
      params.actor.teamId,
      params.run.runId,
      params.run.workflowId,
      params.step.stepId,
      params.step.name,
      params.kind,
      "PENDING",
      JSON.stringify({
        stepIndex: params.stepIndex,
        reason: params.reason,
        ...params.context
      }),
      params.actor.userId,
      new Date().toISOString()
    );
    return approvalId;
  }

  private makeInitialRun(params: {
    actor: RunActor;
    workflowId: string;
    workflowVersion: number;
    workflowName: string;
    steps: WorkflowStep[];
  }): RunState {
    const now = new Date().toISOString();
    const run = RunStateSchema.parse({
      runId: `run_${randomUUID()}`,
      teamId: params.actor.teamId,
      workflowId: params.workflowId,
      workflowVersion: params.workflowVersion,
      workflowName: params.workflowName,
      createdBy: params.actor.userId,
      status: "PENDING",
      currentStepIndex: 0,
      steps: params.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        kind: step.kind,
        agentName: step.agentName,
        status: "PENDING",
        params: step.params ?? {}
      })),
      startedAt: now,
      updatedAt: now,
      context: {}
    });
    const context = this.ensureRuntimeContext(run);
    context.userId = params.actor.userId;
    return run;
  }

  async startRun(params: {
    actor: RunActor;
    workflowId: string;
    workflowVersion?: number;
  }): Promise<RunState> {
    await this.refreshAllowlists();
    const workflowPayload = await this.callMcpAsAgent<
      { workflowId: string; version?: number },
      { workflowId: string; teamId: string; name: string; version: number; steps: WorkflowStep[] }
    >({
      agentName: "Orchestrator Agent",
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: "run-bootstrap",
      workflowId: params.workflowId,
      stepId: "workflow-load",
      server: "registry",
      tool: "get_workflow_version",
      args: {
        workflowId: params.workflowId,
        version: params.workflowVersion
      }
    });

    const run = this.makeInitialRun({
      actor: params.actor,
      workflowId: workflowPayload.workflowId,
      workflowVersion: workflowPayload.version,
      workflowName: workflowPayload.name,
      steps: workflowPayload.steps
    });

    await this.persistRun(run, params.actor);
    await this.emitWarRoomEvent(params.actor, {
      runId: run.runId,
      workflowId: run.workflowId,
      type: "WORKFLOW_STATUS_UPDATE",
      payload: {
        status: run.status,
        workflowName: run.workflowName,
        message: "Workflow run created"
      }
    });
    await this.appendAudit({
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "run",
      agentName: "Orchestrator Agent",
      inputs: { workflowId: run.workflowId, workflowVersion: run.workflowVersion },
      output: { status: "started" },
      confidence: 1,
      rationale: "Run initialized from selected workflow version.",
      toolCalls: [{ server: "store", tool: "upsert_run_state", args: { runId: run.runId } }]
    });

    await this.executeFromCurrentStep(run, params.actor);
    const latest = await this.getRun(run.runId, params.actor.teamId);
    if (!latest) {
      throw new Error("Run disappeared after execution");
    }
    return latest;
  }

  async getRun(runId: string, teamId: string): Promise<RunState | null> {
    const payload = await callMcpTool<{ runId: string }, { run: RunState | null }>("store", "get_run", { runId });
    if (!payload.run || payload.run.teamId !== teamId) {
      return null;
    }
    return RunStateSchema.parse(payload.run);
  }

  private async executeMemoryStep(params: {
    run: RunState;
    step: RunStepState;
    stepParams: Record<string, unknown>;
    actor: RunActor;
  }): Promise<TaskResult> {
    const { run, step, stepParams, actor } = params;
    const mode = String(stepParams.mode ?? "write").toLowerCase();
    const key = String(stepParams.key ?? "").trim();
    if (!key) {
      return {
        output: { error: "Memory key is required.", mode },
        confidence: 0.2,
        rationale: "Memory step missing key.",
        toolCalls: [],
        mockMode: true
      };
    }

    if (mode === "read") {
      const payload = await this.callMcpAsAgent<{ runId: string; workflowId: string; key: string }, { value: unknown }>({
        agentName: "Memory Agent",
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        server: "store",
        tool: "get_memory",
        args: { runId: run.runId, workflowId: run.workflowId, key }
      });
      const assignTo =
        typeof stepParams.assignTo === "string" && stepParams.assignTo.trim()
          ? stepParams.assignTo.trim()
          : "variables.memory";
      setValueByPath(this.ensureRuntimeContext(run) as unknown as Record<string, unknown>, assignTo, payload.value);
      return {
        output: { mode: "read", key, value: payload.value, assignTo },
        confidence: 0.95,
        rationale: "Memory value loaded successfully.",
        toolCalls: [{ server: "store", tool: "get_memory", args: { key } }],
        mockMode: false
      };
    }

    const value = stepParams.value ?? null;
    await this.callMcpAsAgent<{ runId: string; workflowId: string; key: string; value: unknown }, { key: string }>({
      agentName: "Memory Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: step.stepId,
      server: "store",
      tool: "set_memory",
      args: { runId: run.runId, workflowId: run.workflowId, key, value }
    });
    return {
      output: { mode: "write", key, stored: true, value },
      confidence: 0.96,
      rationale: "Memory value persisted successfully.",
      toolCalls: [{ server: "store", tool: "set_memory", args: { key } }],
      mockMode: false
    };
  }

  private async executeFromCurrentStep(run: RunState, actor: RunActor) {
    const teamSettings = getTeamSettingsForServer(actor.teamId, run.workflowId);

    while (run.currentStepIndex >= 0 && run.currentStepIndex < run.steps.length) {
      const idx = run.currentStepIndex;
      const step = run.steps[idx];
      const runtimeContext = this.ensureRuntimeContext(run);
      const startedAt = new Date().toISOString();
      runtimeContext.steps[step.stepId] = { ...(runtimeContext.steps[step.stepId] ?? {}), status: "RUNNING", startedAt };
      run.status = "RUNNING";
      step.status = "RUNNING";
      await this.persistRun(run, actor);
      await this.upsertStepSnapshot(actor, run, step, { startedAt });
      await this.emitWarRoomEvent(actor, {
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        type: "WORKFLOW_STATUS_UPDATE",
        payload: {
          status: run.status,
          stepId: step.stepId,
          stepName: step.name,
          stepStatus: step.status
        },
        timestamp: startedAt
      });

      const resolved = this.resolveStepParams(step, runtimeContext);
      const resolvedParams = resolved.value as Record<string, unknown>;

      if (step.kind === "APPROVAL") {
        const approvalId = this.requestApproval({
          run,
          step,
          stepIndex: idx,
          actor,
          kind: "APPROVAL_NODE",
          reason: String(resolvedParams.reason ?? "Approval node requires approver decision"),
          context: { gateType: "APPROVAL_NODE" }
        });
        step.status = "WAITING_APPROVAL";
        step.approvalId = approvalId;
        run.status = "WAITING_APPROVAL";
        await this.persistRun(run, actor);
        await this.upsertStepSnapshot(actor, run, step, { startedAt });
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "WORKFLOW_STATUS_UPDATE",
          payload: {
            status: run.status,
            stepId: step.stepId,
            stepName: step.name,
            waitingFor: "APPROVAL_NODE"
          }
        });
        return;
      }

      if (step.kind === "ROUTER") {
        if (resolvedParams.requiresApproval === true && resolvedParams.__routerApproved !== true) {
          const decision = await this.createRouterDecision(actor, run, step);
          step.status = "WAITING_APPROVAL";
          step.approvalId = decision.id;
          run.status = "WAITING_APPROVAL";
          await this.persistRun(run, actor);
          await this.upsertStepSnapshot(actor, run, step, { startedAt });
          await this.emitWarRoomEvent(actor, {
            runId: run.runId,
            workflowId: run.workflowId,
            stepId: step.stepId,
            type: "ROUTER_DECISION_REQUIRED",
            payload: {
              decisionId: decision.id,
              routerStepId: step.stepId,
              reason: String(resolvedParams.reason ?? "Router requires approval before evaluation."),
              routes: Array.isArray(resolvedParams.routes) ? resolvedParams.routes : []
            }
          });
          return;
        }

        const routes = Array.isArray(resolvedParams.routes) ? resolvedParams.routes : [];
        let selected: { label: string; condition: string; toNodeId: string } | undefined;
        for (const route of routes) {
          if (!route || typeof route !== "object") {
            continue;
          }
          const candidate = route as Record<string, unknown>;
          const result = evaluateRouteCondition(String(candidate.condition ?? ""), runtimeContext as unknown as Record<string, unknown>);
          if (result.error) {
            continue;
          }
          if (result.matched) {
            selected = {
              label: String(candidate.label ?? candidate.condition ?? "route"),
              condition: String(candidate.condition ?? ""),
              toNodeId: String(candidate.toNodeId ?? "")
            };
            break;
          }
        }
        const nextStepId =
          selected?.toNodeId || (typeof resolvedParams.defaultRouteToNodeId === "string" ? resolvedParams.defaultRouteToNodeId : "");
        const nextIndex = this.getStepIndexById(run, nextStepId);
        if (!nextStepId || nextIndex < 0) {
          throw new Error(`Router step ${step.stepId} could not find a matching/default route.`);
        }
        const output = {
          selectedRoute: selected ?? { label: "default", condition: "default", toNodeId: nextStepId },
          nextStepId,
          meta: { templateWarnings: resolved.warnings }
        };
        await this.callMcpAsAgent<
          { runId: string; stepId: string; output: Record<string, unknown>; confidence: number; rationale: string; status: "COMPLETED" },
          { run: RunState }
        >({
          agentName: "Orchestrator Agent",
          userId: actor.userId,
          teamId: actor.teamId,
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          server: "store",
          tool: "write_output",
          args: { runId: run.runId, stepId: step.stepId, output, confidence: 1, rationale: "Router selected route.", status: "COMPLETED" }
        });
        step.output = output;
        step.confidence = 1;
        step.rationale = "Router selected downstream branch.";
        step.status = "COMPLETED";
        runtimeContext.steps[step.stepId] = { status: "COMPLETED", output, startedAt, endedAt: new Date().toISOString() };
        runtimeContext.lastOutput = output;
        run.currentStepIndex = nextIndex;
        await this.persistRun(run, actor);
        await this.upsertStepSnapshot(actor, run, step, { startedAt, finishedAt: new Date().toISOString() });
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "WORKFLOW_STATUS_UPDATE",
          payload: {
            status: run.status,
            stepId: step.stepId,
            stepStatus: step.status,
            selectedRoute: output.selectedRoute
          }
        });
        continue;
      }

      const renderedQuery = typeof resolvedParams.query === "string" ? resolvedParams.query : "";
      const dbWritePending =
        step.agentName === "LLM Agent" &&
        resolvedParams.allowDbWrite === true &&
        renderedQuery &&
        isLikelyWriteSql(renderedQuery) &&
        resolvedParams.__dbWriteApproved !== true;
      if (dbWritePending) {
        const approvalId = this.requestApproval({
          run,
          step,
          stepIndex: idx,
          actor,
          kind: "POLICY_GATE",
          reason: "LLM DB write requires approval before execution.",
          context: {
            gateType: "DB_WRITE",
            renderedSql: renderedQuery,
            queryParams: Array.isArray(resolvedParams.queryParams) ? resolvedParams.queryParams : [],
            connectionTarget: redactConnectionTarget(String(resolvedParams.connectionString ?? "")),
            stopOnReject: resolvedParams.stopOnReject === true
          }
        });
        step.status = "WAITING_APPROVAL";
        step.approvalId = approvalId;
        run.status = "WAITING_APPROVAL";
        await this.persistRun(run, actor);
        await this.upsertStepSnapshot(actor, run, step, { startedAt });
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "WORKFLOW_STATUS_UPDATE",
          payload: {
            status: run.status,
            stepId: step.stepId,
            stepName: step.name,
            waitingFor: "POLICY_GATE"
          }
        });
        return;
      }

      const policyInput = runPolicyInputCheck({ stepParams: resolvedParams, runContext: runtimeContext });
      const taskResult =
        step.agentName === "Memory Agent"
          ? await this.executeMemoryStep({
              run,
              step,
              stepParams: (policyInput.sanitizedInput.stepParams ?? {}) as Record<string, unknown>,
              actor
            })
          : await runTaskAgent({
              agentName: step.agentName ?? "Unknown Agent",
              stepParams: (policyInput.sanitizedInput.stepParams ?? {}) as Record<string, unknown>,
              runContext: (policyInput.sanitizedInput.runContext ?? {}) as Record<string, unknown>,
              teamSettings
            });

      const outputWithMeta = { ...taskResult.output, meta: { templateWarnings: resolved.warnings } };
      const verifier = runVerifier(
        outputWithMeta,
        taskResult.confidence,
        typeof resolvedParams.confidenceThreshold === "number" ? Number(resolvedParams.confidenceThreshold) : undefined
      );
      const policyOutput = runPolicyOutputCheck(outputWithMeta, taskResult.confidence);
      const requiresApproval = verifier.requiresApproval || policyOutput.requiresApproval;
      const nextStatus = requiresApproval ? "WAITING_APPROVAL" : "COMPLETED";

      await this.callMcpAsAgent<
        { runId: string; stepId: string; output: Record<string, unknown>; confidence: number; rationale: string; status: "WAITING_APPROVAL" | "COMPLETED" },
        { run: RunState }
      >({
        agentName: step.agentName ?? "Unknown Agent",
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        server: "store",
        tool: "write_output",
        args: {
          runId: run.runId,
          stepId: step.stepId,
          output: outputWithMeta,
          confidence: taskResult.confidence,
          rationale: taskResult.rationale,
          status: nextStatus
        }
      });

      step.output = outputWithMeta;
      step.confidence = taskResult.confidence;
      step.rationale = taskResult.rationale;
      this.refreshContextFromStep(run, step);

      const lowerStepName = `${step.name} ${step.stepId} ${step.agentName ?? ""}`.toLowerCase();
      const outputRecord = outputWithMeta as Record<string, unknown>;
      const isDebateStep =
        lowerStepName.includes("debate") ||
        Array.isArray(outputRecord.arguments) ||
        typeof outputRecord.finalRecommendation === "string";
      if (isDebateStep) {
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "DEBATE_RESULT",
          payload: {
            topic: outputRecord.topic ?? outputRecord.debateTopic ?? step.name,
            arguments: Array.isArray(outputRecord.arguments) ? outputRecord.arguments : [],
            finalRecommendation: outputRecord.finalRecommendation ?? outputRecord.recommendation ?? "No recommendation",
            confidence: step.confidence ?? null,
            participants: outputRecord.participants ?? []
          }
        });
      }

      if (
        lowerStepName.includes("inventory") ||
        lowerStepName.includes("supplier") ||
        lowerStepName.includes("procurement") ||
        lowerStepName.includes("vendor") ||
        lowerStepName.includes("po")
      ) {
        const alertCategory = lowerStepName.includes("inventory")
          ? "inventory"
          : lowerStepName.includes("supplier")
            ? "supplier"
            : "procurement";
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "AGENT_ALERT",
          payload: {
            category: alertCategory,
            stepName: step.name,
            severity: outputRecord.severity ?? "medium",
            riskScore: outputRecord.riskScore ?? null,
            summary: outputRecord.summary ?? step.rationale ?? `${step.name} updated`,
            output: outputWithMeta
          }
        });
      }

      if (requiresApproval) {
        const approvalId = this.requestApproval({
          run,
          step,
          stepIndex: idx,
          actor,
          kind: "POLICY_GATE",
          reason: "Policy gate requires approval.",
          context: { gateType: "POLICY_GATE", confidence: taskResult.confidence, output: outputWithMeta }
        });
        step.status = "WAITING_APPROVAL";
        step.approvalId = approvalId;
        run.status = "WAITING_APPROVAL";
        run.currentStepIndex = idx;
        await this.persistRun(run, actor);
        await this.upsertStepSnapshot(actor, run, step, { startedAt });
        await this.emitWarRoomEvent(actor, {
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          type: "WORKFLOW_STATUS_UPDATE",
          payload: {
            status: run.status,
            stepId: step.stepId,
            stepName: step.name,
            waitingFor: "POLICY_GATE"
          }
        });
        return;
      }

      step.status = "COMPLETED";
      this.refreshContextFromStep(run, step);
      const nextStepId = typeof resolvedParams.nextStepId === "string" ? resolvedParams.nextStepId : "";
      const nextIndex = this.getStepIndexById(run, nextStepId);
      run.currentStepIndex = nextStepId && nextIndex >= 0 ? nextIndex : idx + 1;
      await this.persistRun(run, actor);
      await this.upsertStepSnapshot(actor, run, step, { startedAt, finishedAt: new Date().toISOString() });
      await this.emitWarRoomEvent(actor, {
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        type: "WORKFLOW_STATUS_UPDATE",
        payload: {
          status: run.status,
          stepId: step.stepId,
          stepName: step.name,
          stepStatus: step.status
        }
      });
    }

    run.status = "COMPLETED";
    run.completedAt = new Date().toISOString();
    run.currentStepIndex = run.steps.length;
    await this.persistRun(run, actor);
    await this.emitWarRoomEvent(actor, {
      runId: run.runId,
      workflowId: run.workflowId,
      type: "WORKFLOW_STATUS_UPDATE",
      payload: {
        status: run.status,
        message: "Workflow completed"
      },
      timestamp: run.completedAt
    });
    await this.generateOptimization(run, actor);
  }

  private async generateOptimization(run: RunState, actor: RunActor) {
    const query = await this.callMcpAsAgent<{ runId: string; teamId: string; limit: number }, { records: Array<Record<string, unknown>> }>({
      agentName: "Optimization Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "optimization",
      server: "audit",
      tool: "query_records",
      args: { runId: run.runId, teamId: run.teamId, limit: 1000 }
    });

    const proposal = createOptimizationProposal({
      teamId: run.teamId,
      workflowId: run.workflowId,
      runId: run.runId,
      records: query.records as Array<{
        id: string;
        timestamp: string;
        userId: string;
        teamId: string;
        runId: string;
        workflowId: string;
        stepId: string;
        agentName: string;
        inputs: Record<string, unknown>;
        output: unknown;
        confidence: number;
        rationale: string;
        toolCalls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
      }>
    });

    await this.appendAudit({
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "optimization",
      agentName: "Optimization Agent",
      inputs: { recordCount: query.records.length },
      output: proposal,
      confidence: 0.86,
      rationale: "Generated PR-style workflow improvement proposal for manual review only.",
      toolCalls: [{ server: "audit", tool: "query_records", args: { runId: run.runId } }]
    });
  }

  async listRuns(teamId: string) {
    const payload = await callMcpTool<{ teamId: string }, { runs: RunState[] }>("store", "list_runs", { teamId });
    return payload.runs.map((run) => RunStateSchema.parse(run));
  }

  async listPendingApprovals(teamId: string) {
    const rows = db
      .prepare("SELECT * FROM approvals WHERE team_id = ? AND status = 'PENDING' ORDER BY requested_at DESC")
      .all(teamId) as ApprovalRow[];

    return rows.map((row) => ({
      id: row.id,
      teamId: row.team_id,
      runId: row.run_id,
      workflowId: row.workflow_id,
      stepId: row.step_id,
      stepName: row.step_name,
      kind: row.kind,
      status: row.status,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      context: JSON.parse(row.context_json)
    }));
  }

  async decideRouterDecision(params: {
    runId: string;
    routerStepId: string;
    decision: "approve" | "reject";
    actor: RunActor;
  }) {
    await this.refreshAllowlists();
    const run = await this.getRun(params.runId, params.actor.teamId);
    if (!run) {
      throw new Error("Run not found");
    }

    const pending = await this.callMcpAsAgent<{ runId: string }, { decisions: RouterDecisionRecord[] }>({
      agentName: "Orchestrator Agent",
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: params.routerStepId,
      server: "store",
      tool: "list_pending_router_decisions",
      args: { runId: run.runId }
    });

    const request = pending.decisions.find((item) => item.routerStepId === params.routerStepId);
    if (!request) {
      throw new Error("No pending router decision for step");
    }

    await this.callMcpAsAgent<{ id: string; decision: "approve" | "reject" }, { decision: RouterDecisionRecord }>({
      agentName: "Orchestrator Agent",
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: params.routerStepId,
      server: "store",
      tool: "resolve_router_decision",
      args: {
        id: request.id,
        decision: params.decision
      }
    });

    const stepIndex = run.steps.findIndex((step) => step.stepId === params.routerStepId);
    if (stepIndex < 0) {
      throw new Error("Router step not found in run");
    }
    const step = run.steps[stepIndex];
    const runtimeContext = this.ensureRuntimeContext(run);
    runtimeContext.variables.routerDecision = params.decision;
    step.params = { ...step.params, __routerApproved: true };
    step.status = "PENDING";
    run.currentStepIndex = stepIndex;
    run.status = "RUNNING";
    await this.persistRun(run, params.actor);
    await this.emitWarRoomEvent(params.actor, {
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: params.routerStepId,
      type: "WORKFLOW_STATUS_UPDATE",
      payload: {
        status: run.status,
        message: `Router decision received: ${params.decision}`
      }
    });
    await this.executeFromCurrentStep(run, params.actor);

    const refreshed = await this.getRun(run.runId, params.actor.teamId);
    if (!refreshed) {
      throw new Error("Run not found after router decision");
    }
    return refreshed;
  }

  async decideApproval(params: {
    approvalId: string;
    decision: "APPROVE" | "REJECT";
    comment?: string;
    actor: RunActor;
  }) {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ? LIMIT 1").get(params.approvalId) as ApprovalRow | undefined;
    if (!row) {
      throw new Error("Approval not found");
    }
    if (row.team_id !== params.actor.teamId) {
      throw new Error("Approval belongs to another team");
    }
    if (row.status !== "PENDING") {
      throw new Error("Approval already resolved");
    }

    const now = new Date().toISOString();
    const status = params.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?").run(
      status,
      params.actor.userId,
      now,
      params.comment ?? null,
      params.approvalId
    );

    const run = await this.getRun(row.run_id, params.actor.teamId);
    if (!run) {
      throw new Error("Run not found for approval");
    }
    const context = JSON.parse(row.context_json) as Record<string, unknown>;
    const stepIndex = run.steps.findIndex((step) => step.stepId === row.step_id);
    if (stepIndex < 0) {
      throw new Error("Step not found in run for approval");
    }
    const step = run.steps[stepIndex];
    const gateType = String(context.gateType ?? "");

    if (params.decision === "REJECT") {
      if (gateType === "DB_WRITE" && context.stopOnReject !== true) {
        step.status = "COMPLETED";
        step.output = { meta: { rejected: true, reason: params.comment ?? "Rejected" } };
        step.rationale = "DB write rejected and skipped.";
        run.status = "RUNNING";
        run.currentStepIndex = stepIndex + 1;
        await this.persistRun(run, params.actor);
        await this.executeFromCurrentStep(run, params.actor);
        const refreshed = await this.getRun(run.runId, params.actor.teamId);
        if (!refreshed) {
          throw new Error("Run not found after rejection resume");
        }
        return refreshed;
      }
      step.status = "REJECTED";
      run.status = "REJECTED";
      run.error = `Rejected by approver: ${params.comment ?? "No comment"}`;
      run.completedAt = now;
      await this.persistRun(run, params.actor);
      return run;
    }

    if (gateType === "DB_WRITE") {
      step.params = { ...step.params, __dbWriteApproved: true };
      step.status = "PENDING";
      run.currentStepIndex = stepIndex;
    } else if (gateType === "ROUTER_APPROVAL") {
      step.params = { ...step.params, __routerApproved: true };
      step.status = "PENDING";
      run.currentStepIndex = stepIndex;
    } else {
      step.status = "COMPLETED";
      run.currentStepIndex = stepIndex + 1;
    }
    run.status = "RUNNING";
    await this.persistRun(run, params.actor);
    await this.executeFromCurrentStep(run, params.actor);
    const refreshed = await this.getRun(run.runId, params.actor.teamId);
    if (!refreshed) {
      throw new Error("Run not found after approval resume");
    }
    return refreshed;
  }
}

export const orchestrator = new OrchestratorService();
