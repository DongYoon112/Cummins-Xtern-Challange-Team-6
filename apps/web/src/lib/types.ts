export type Role = "BUILDER" | "OPERATOR" | "APPROVER" | "AUDITOR";

export type User = {
  id: string;
  username: string;
  role: Role;
  teamId: string;
};

export type WorkflowStep = {
  id: string;
  name: string;
  kind: "AGENT" | "APPROVAL";
  agentName?: string;
  params: Record<string, unknown>;
};

export type WorkflowSummary = {
  workflowId: string;
  teamId: string;
  name: string;
  description?: string;
  latestVersion: number;
  updatedAt: string;
  forkedFrom?: string;
};

export type RunStep = {
  stepId: string;
  name: string;
  kind: "AGENT" | "APPROVAL";
  agentName?: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "REJECTED" | "FAILED";
  params: Record<string, unknown>;
  output?: unknown;
  confidence?: number;
  rationale?: string;
  approvalId?: string;
};

export type RunState = {
  runId: string;
  teamId: string;
  workflowId: string;
  workflowVersion: number;
  workflowName: string;
  createdBy: string;
  status: "PENDING" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "REJECTED" | "FAILED";
  currentStepIndex: number;
  steps: RunStep[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  context: Record<string, unknown>;
  error?: string;
};