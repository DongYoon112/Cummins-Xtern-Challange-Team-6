import { randomUUID } from "node:crypto";
import type { RunState, RunStepState, WorkflowStep } from "@agentfoundry/shared";
import { RunStateSchema } from "@agentfoundry/shared";
import { db } from "../lib/db";
import { callMcpTool } from "../lib/mcpClient";
import { getTeamSettingsForServer } from "../lib/settings";
import { runPolicyInputCheck, runPolicyOutputCheck } from "./policyAgent";
import { runTaskAgent } from "./taskAgents";
import { runVerifier } from "./verifierAgent";
import { createOptimizationProposal } from "./optimizationAgent";

type AgentCatalogRow = {
  name: string;
  allowlist: string[];
};

type RunActor = {
  userId: string;
  username: string;
  teamId: string;
};

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

export class OrchestratorService {
  private allowlists = new Map<string, string[]>();

  private async refreshAllowlists() {
    const payload = await callMcpTool<
      { includeDisabled?: boolean },
      { agents: AgentCatalogRow[] }
    >("registry", "list_agents", {});

    this.allowlists.clear();
    for (const agent of payload.agents) {
      this.allowlists.set(agent.name, agent.allowlist);
    }
  }

  private canCall(agentName: string, server: "registry" | "store" | "audit", tool: string) {
    const allowlist = this.allowlists.get(agentName) ?? [];
    return allowlist.includes(`${server}.${tool}`);
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

    const result = await callMcpTool<TArgs, TResult>(server, tool, args);
    return result;
  }

  private hydrateContext(run: RunState, output: Record<string, unknown>) {
    if (typeof output.shortageQty === "number") {
      run.context.lastShortageQty = output.shortageQty;
    }
    if (typeof output.shippingCostUSD === "number") {
      run.context.lastLogisticsCostUSD = output.shippingCostUSD;
    }
    if (typeof output.destination === "string") {
      run.context.destination = output.destination;
    }
    if (typeof output.summary === "string") {
      run.context.lastSummary = output.summary;
    }
    if (typeof output.message === "string") {
      run.context.lastSummary = output.message;
    }
    if (typeof output.orderId === "string") {
      run.context.orderId = output.orderId;
    }
    if (typeof output.supplierId === "string") {
      run.context.supplierId = output.supplierId;
    }
    if (typeof output.costImpactUSD === "number") {
      run.context.lastCostImpactUSD = output.costImpactUSD;
    }

    run.context[`output_${new Date().getTime()}`] = output;
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
    return RunStateSchema.parse({
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
  }

  async startRun(params: {
    actor: RunActor;
    workflowId: string;
    workflowVersion?: number;
  }): Promise<RunState> {
    await this.refreshAllowlists();

    const workflowPayload = await this.callMcpAsAgent<
      { workflowId: string; version?: number },
      {
        workflowId: string;
        teamId: string;
        name: string;
        version: number;
        steps: WorkflowStep[];
      }
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
    await this.appendAudit({
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "run",
      agentName: "Orchestrator Agent",
      inputs: {
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion
      },
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
    const payload = await callMcpTool<{ runId: string }, { run: RunState | null }>("store", "get_run", {
      runId
    });

    if (!payload.run || payload.run.teamId !== teamId) {
      return null;
    }

    return RunStateSchema.parse(payload.run);
  }

  private async executeFromCurrentStep(run: RunState, actor: RunActor) {
    const teamSettings = getTeamSettingsForServer(actor.teamId);

    for (let idx = run.currentStepIndex; idx < run.steps.length; idx += 1) {
      const step = run.steps[idx];
      run.status = "RUNNING";
      run.currentStepIndex = idx;
      step.status = "RUNNING";
      await this.persistRun(run, actor);

      await this.appendAudit({
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: "Orchestrator Agent",
        inputs: { step: step.name, kind: step.kind, params: step.params },
        output: { status: "step_running" },
        confidence: 1,
        rationale: "Executing next workflow step.",
        toolCalls: []
      });

      if (step.kind === "APPROVAL") {
        const approvalId = this.requestApproval({
          run,
          step,
          stepIndex: idx,
          actor,
          kind: "APPROVAL_NODE",
          reason: String(step.params.reason ?? "Approval node requires approver decision"),
          context: {}
        });

        step.status = "WAITING_APPROVAL";
        step.approvalId = approvalId;
        run.status = "WAITING_APPROVAL";
        await this.persistRun(run, actor);

        await this.appendAudit({
          userId: actor.userId,
          teamId: actor.teamId,
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          agentName: "Policy/Governance Agent",
          inputs: { approvalId, reason: step.params.reason },
          output: { status: "approval_requested" },
          confidence: 1,
          rationale: "Approval node paused run until approver decision.",
          toolCalls: []
        });

        return;
      }

      const policyInput = runPolicyInputCheck({
        stepParams: step.params,
        runContext: run.context
      });

      await this.appendAudit({
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: "Policy/Governance Agent",
        inputs: { stepParams: step.params, runContext: run.context },
        output: {
          blockedFields: policyInput.blockedFields,
          sanitizedInput: policyInput.sanitizedInput
        },
        confidence: 1,
        rationale: policyInput.rationale,
        toolCalls: []
      });

      const taskResult = await runTaskAgent({
        agentName: step.agentName ?? "Unknown Agent",
        stepParams: (policyInput.sanitizedInput.stepParams ?? {}) as Record<string, unknown>,
        runContext: (policyInput.sanitizedInput.runContext ?? {}) as Record<string, unknown>,
        teamSettings
      });

      await this.appendAudit({
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: step.agentName ?? "Unknown Agent",
        inputs: {
          stepParams: policyInput.sanitizedInput.stepParams,
          runContext: policyInput.sanitizedInput.runContext
        },
        output: taskResult.output,
        confidence: taskResult.confidence,
        rationale: taskResult.rationale,
        toolCalls: taskResult.toolCalls
      });

      const verifier = runVerifier(
        taskResult.output,
        taskResult.confidence,
        typeof step.params.confidenceThreshold === "number"
          ? Number(step.params.confidenceThreshold)
          : undefined
      );

      await this.appendAudit({
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: "Verifier Agent",
        inputs: {
          output: taskResult.output,
          confidence: taskResult.confidence,
          threshold: step.params.confidenceThreshold
        },
        output: verifier,
        confidence: verifier.valid ? 0.95 : 0.5,
        rationale: verifier.rationale,
        toolCalls: []
      });

      const policyOutput = runPolicyOutputCheck(taskResult.output, taskResult.confidence);
      const requiresApproval = verifier.requiresApproval || policyOutput.requiresApproval;

      await this.appendAudit({
        userId: actor.userId,
        teamId: actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: "Policy/Governance Agent",
        inputs: {
          output: taskResult.output,
          confidence: taskResult.confidence,
          verifier
        },
        output: policyOutput,
        confidence: 1,
        rationale: policyOutput.rationale,
        toolCalls: []
      });

      const nextStatus = requiresApproval ? "WAITING_APPROVAL" : "COMPLETED";

      await this.callMcpAsAgent<
        {
          runId: string;
          stepId: string;
          output: Record<string, unknown>;
          confidence: number;
          rationale: string;
          status: "WAITING_APPROVAL" | "COMPLETED";
        },
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
          output: taskResult.output,
          confidence: taskResult.confidence,
          rationale: taskResult.rationale,
          status: nextStatus
        }
      });

      step.output = taskResult.output;
      step.confidence = taskResult.confidence;
      step.rationale = taskResult.rationale;

      this.hydrateContext(run, taskResult.output);

      if (requiresApproval) {
        const approvalReason = [
          ...policyOutput.reasons,
          verifier.requiresApproval ? verifier.rationale : ""
        ]
          .filter(Boolean)
          .join(" | ");

        const approvalId = this.requestApproval({
          run,
          step,
          stepIndex: idx,
          actor,
          kind: "POLICY_GATE",
          reason: approvalReason,
          context: {
            confidence: taskResult.confidence,
            output: taskResult.output
          }
        });

        step.status = "WAITING_APPROVAL";
        step.approvalId = approvalId;
        run.status = "WAITING_APPROVAL";
        run.currentStepIndex = idx;
        await this.persistRun(run, actor);

        await this.appendAudit({
          userId: actor.userId,
          teamId: actor.teamId,
          runId: run.runId,
          workflowId: run.workflowId,
          stepId: step.stepId,
          agentName: "Policy/Governance Agent",
          inputs: {
            approvalId,
            reason: approvalReason
          },
          output: { status: "approval_requested" },
          confidence: 1,
          rationale: "Policy gate paused run pending approver decision.",
          toolCalls: []
        });

        return;
      }

      step.status = "COMPLETED";
      run.currentStepIndex = idx + 1;
      await this.persistRun(run, actor);
    }

    run.status = "COMPLETED";
    run.completedAt = new Date().toISOString();
    run.currentStepIndex = run.steps.length;
    await this.persistRun(run, actor);

    await this.appendAudit({
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "run",
      agentName: "Orchestrator Agent",
      inputs: { finalStepCount: run.steps.length },
      output: { status: "completed" },
      confidence: 1,
      rationale: "Workflow run completed all steps.",
      toolCalls: []
    });

    await this.generateOptimization(run, actor);
  }

  private async generateOptimization(run: RunState, actor: RunActor) {
    const query = await this.callMcpAsAgent<
      { runId: string; teamId: string; limit: number },
      { records: Array<Record<string, unknown>> }
    >({
      agentName: "Optimization Agent",
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "optimization",
      server: "audit",
      tool: "query_records",
      args: {
        runId: run.runId,
        teamId: run.teamId,
        limit: 1000
      }
    });

    const records = query.records as Array<{
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
    }>;

    const proposal = createOptimizationProposal({
      teamId: run.teamId,
      workflowId: run.workflowId,
      runId: run.runId,
      records
    });

    await this.appendAudit({
      userId: actor.userId,
      teamId: actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: "optimization",
      agentName: "Optimization Agent",
      inputs: {
        recordCount: records.length
      },
      output: proposal,
      confidence: 0.86,
      rationale: "Generated PR-style workflow improvement proposal for manual review only.",
      toolCalls: [{ server: "audit", tool: "query_records", args: { runId: run.runId } }]
    });
  }

  async listRuns(teamId: string) {
    const payload = await callMcpTool<{ teamId: string }, { runs: RunState[] }>("store", "list_runs", {
      teamId
    });

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

  async decideApproval(params: {
    approvalId: string;
    decision: "APPROVE" | "REJECT";
    comment?: string;
    actor: RunActor;
  }) {
    const row = db.prepare("SELECT * FROM approvals WHERE id = ? LIMIT 1").get(params.approvalId) as
      | ApprovalRow
      | undefined;

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
    db.prepare(
      "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?"
    ).run(status, params.actor.userId, now, params.comment ?? null, params.approvalId);

    const run = await this.getRun(row.run_id, params.actor.teamId);
    if (!run) {
      throw new Error("Run not found for approval");
    }

    const stepIndex = run.steps.findIndex((step) => step.stepId === row.step_id);
    if (stepIndex === -1) {
      throw new Error("Step not found in run for approval");
    }

    const step = run.steps[stepIndex];

    if (params.decision === "REJECT") {
      step.status = "REJECTED";
      run.status = "REJECTED";
      run.error = `Rejected by approver: ${params.comment ?? "No comment"}`;
      run.completedAt = now;
      await this.persistRun(run, params.actor);

      await this.appendAudit({
        userId: params.actor.userId,
        teamId: params.actor.teamId,
        runId: run.runId,
        workflowId: run.workflowId,
        stepId: step.stepId,
        agentName: "Policy/Governance Agent",
        inputs: {
          approvalId: row.id,
          decision: params.decision,
          comment: params.comment
        },
        output: { status: "rejected" },
        confidence: 1,
        rationale: "Approver rejected pending step. Run marked as REJECTED.",
        toolCalls: []
      });

      return run;
    }

    step.status = "COMPLETED";
    run.status = "RUNNING";
    run.currentStepIndex = stepIndex + 1;
    await this.persistRun(run, params.actor);

    await this.appendAudit({
      userId: params.actor.userId,
      teamId: params.actor.teamId,
      runId: run.runId,
      workflowId: run.workflowId,
      stepId: step.stepId,
      agentName: "Policy/Governance Agent",
      inputs: {
        approvalId: row.id,
        decision: params.decision,
        comment: params.comment
      },
      output: { status: "approved" },
      confidence: 1,
      rationale: "Approver approved pending step. Run resumed.",
      toolCalls: []
    });

    await this.executeFromCurrentStep(run, params.actor);
    const refreshed = await this.getRun(run.runId, params.actor.teamId);
    if (!refreshed) {
      throw new Error("Run not found after approval resume");
    }

    return refreshed;
  }
}

export const orchestrator = new OrchestratorService();
