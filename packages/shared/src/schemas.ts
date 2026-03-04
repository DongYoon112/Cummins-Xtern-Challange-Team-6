import { z } from "zod";

export const RoleSchema = z.enum(["ADMIN", "BUILDER", "OPERATOR", "APPROVER", "AUDITOR"]);
export type Role = z.infer<typeof RoleSchema>;

export const ProviderSchema = z.enum(["openai", "anthropic", "gemini"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const StepKindSchema = z.enum(["AGENT", "APPROVAL"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const RunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "REJECTED",
  "FAILED"
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "REJECTED",
  "FAILED"
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: StepKindSchema,
  agentName: z.string().optional(),
  params: z.record(z.any()).default({})
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowVersionSchema = z.object({
  workflowId: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  version: z.number().int().positive(),
  changelog: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  steps: z.array(WorkflowStepSchema)
});
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

export const WorkflowSummarySchema = z.object({
  workflowId: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  latestVersion: z.number().int().positive(),
  updatedAt: z.string(),
  forkedFrom: z.string().nullable().optional()
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

export const RunStepStateSchema = z.object({
  stepId: z.string(),
  name: z.string(),
  kind: StepKindSchema,
  agentName: z.string().optional(),
  status: StepStatusSchema,
  params: z.record(z.any()).default({}),
  output: z.any().optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  approvalId: z.string().optional()
});
export type RunStepState = z.infer<typeof RunStepStateSchema>;

export const RunStateSchema = z.object({
  runId: z.string(),
  teamId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number().int().positive(),
  workflowName: z.string(),
  createdBy: z.string(),
  status: RunStatusSchema,
  currentStepIndex: z.number().int().nonnegative(),
  steps: z.array(RunStepStateSchema),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  context: z.record(z.any()).default({}),
  error: z.string().optional()
});
export type RunState = z.infer<typeof RunStateSchema>;

export const AuditRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  userId: z.string(),
  teamId: z.string(),
  runId: z.string(),
  workflowId: z.string(),
  stepId: z.string(),
  agentName: z.string(),
  inputs: z.record(z.any()).default({}),
  output: z.any(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  toolCalls: z.array(z.object({
    server: z.string(),
    tool: z.string(),
    args: z.record(z.any())
  }))
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const AgentCatalogEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["ORCHESTRATOR", "POLICY", "VERIFIER", "TASK", "OPTIMIZATION"]),
  description: z.string(),
  allowlist: z.array(z.string()),
  defaultParams: z.record(z.any()).default({})
});
export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntrySchema>;

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    name: "Orchestrator Agent",
    type: "ORCHESTRATOR",
    description: "Runs workflow steps in order and coordinates agents.",
    allowlist: [
      "registry.get_workflow_version",
      "registry.list_agents",
      "store.get_run",
      "store.upsert_run_state",
      "store.write_output",
      "audit.append_record",
      "audit.query_records"
    ],
    defaultParams: {}
  },
  {
    name: "Policy/Governance Agent",
    type: "POLICY",
    description: "Enforces confidence, spend, PII, and allowlist policies.",
    allowlist: ["audit.append_record"],
    defaultParams: {
      approvalConfidenceThreshold: 0.6,
      approvalCostThresholdUSD: 500
    }
  },
  {
    name: "Verifier Agent",
    type: "VERIFIER",
    description: "Validates output schema and flags low-confidence outputs.",
    allowlist: ["audit.append_record"],
    defaultParams: {
      minimumConfidence: 0.6
    }
  },
  {
    name: "Inventory Agent",
    type: "TASK",
    description: "Checks inventory availability and backorder options.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Supplier Risk Agent",
    type: "TASK",
    description: "Evaluates supplier disruption and financial risk signals.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Logistics Agent",
    type: "TASK",
    description: "Selects candidate shipping options and lead times.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Finance Agent",
    type: "TASK",
    description: "Estimates margin and cost impact of recommendation.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {
      costThreshold: 500
    }
  },
  {
    name: "Notification Agent",
    type: "TASK",
    description: "Builds stakeholder notification messages.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Optimization Agent",
    type: "OPTIMIZATION",
    description: "Analyzes audit history and proposes workflow improvements.",
    allowlist: ["audit.query_records", "audit.append_record"],
    defaultParams: {}
  }
];

export const BUILTIN_WORKFLOW_TEMPLATES = [
  {
    name: "Backorder Resolution",
    description: "Resolve order backorders with cost-aware logistics and approvals.",
    changelog: "Seeded template",
    steps: [
      {
        id: "inventory-check",
        name: "Inventory Check",
        kind: "AGENT" as const,
        agentName: "Inventory Agent",
        params: { sku: "SKU-100", orderId: "ORD-1001" }
      },
      {
        id: "logistics-plan",
        name: "Logistics Plan",
        kind: "AGENT" as const,
        agentName: "Logistics Agent",
        params: { destination: "Indianapolis" }
      },
      {
        id: "finance-impact",
        name: "Finance Impact",
        kind: "AGENT" as const,
        agentName: "Finance Agent",
        params: { confidenceThreshold: 0.7, costThreshold: 500 }
      },
      {
        id: "manager-approval",
        name: "Manager Approval",
        kind: "APPROVAL" as const,
        params: { reason: "High-impact action approval" }
      },
      {
        id: "notify-team",
        name: "Notify Team",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: { channel: "email" }
      }
    ]
  },
  {
    name: "Supplier Risk Check",
    description: "Assess supplier risk before PO release.",
    changelog: "Seeded template",
    steps: [
      {
        id: "supplier-risk",
        name: "Supplier Risk",
        kind: "AGENT" as const,
        agentName: "Supplier Risk Agent",
        params: { supplierId: "SUP-02" }
      },
      {
        id: "finance-review",
        name: "Finance Review",
        kind: "AGENT" as const,
        agentName: "Finance Agent",
        params: { costThreshold: 500 }
      },
      {
        id: "risk-approval",
        name: "Risk Approval",
        kind: "APPROVAL" as const,
        params: { reason: "Supplier risk requires approver" }
      }
    ]
  }
];

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  gemini: "gemini-2.0-flash"
};
