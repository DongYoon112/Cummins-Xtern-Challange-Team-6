import { z } from "zod";

export const RoleSchema = z.enum(["ADMIN", "BUILDER", "OPERATOR", "APPROVER", "AUDITOR"]);
export type Role = z.infer<typeof RoleSchema>;

export const ProviderSchema = z.enum(["openai", "anthropic", "gemini"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const StepKindSchema = z.enum(["AGENT", "APPROVAL", "ROUTER"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const DebateStanceSchema = z.enum(["APPROVE", "BLOCK", "CONDITIONAL"]);
export type DebateStance = z.infer<typeof DebateStanceSchema>;

export const DebateParticipantConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: ProviderSchema,
  model: z.string().min(1),
  stance: DebateStanceSchema,
  systemPrompt: z.string().optional(),
  weight: z.number().positive().optional()
});
export type DebateParticipantConfig = z.infer<typeof DebateParticipantConfigSchema>;

export const DebateArbiterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: ProviderSchema.optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional()
});
export type DebateArbiterConfig = z.infer<typeof DebateArbiterConfigSchema>;

export const DebateNodeConfigSchema = z.object({
  debateTopic: z.string().optional(),
  debateRounds: z.number().int().positive().default(2),
  participants: z.array(DebateParticipantConfigSchema).optional(),
  arbiter: DebateArbiterConfigSchema.optional(),
  outputSchemaVersion: z.literal("v1").default("v1"),
  requireJson: z.boolean().default(true),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional()
});
export type DebateNodeConfig = z.infer<typeof DebateNodeConfigSchema>;

export const DebateOutputParticipantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: ProviderSchema,
  model: z.string().min(1),
  stance: DebateStanceSchema
});
export type DebateOutputParticipant = z.infer<typeof DebateOutputParticipantSchema>;

export const DebateArgumentSchema = z.object({
  round: z.number().int().positive(),
  participantId: z.string().min(1),
  stance: DebateStanceSchema,
  summary: z.string(),
  keyPoints: z.array(z.string()),
  risks: z.array(z.string()),
  mitigations: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  raw: z.string().optional()
});
export type DebateArgument = z.infer<typeof DebateArgumentSchema>;

export const DebateFinalRecommendationSchema = z.object({
  decision: DebateStanceSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  conditions: z.array(z.string()),
  nextActions: z.array(z.string())
});
export type DebateFinalRecommendation = z.infer<typeof DebateFinalRecommendationSchema>;

export const DebateOutputSchema = z.object({
  schemaVersion: z.literal("v1"),
  topic: z.string(),
  rounds: z.number().int().positive(),
  participants: z.array(DebateOutputParticipantSchema),
  arguments: z.array(DebateArgumentSchema),
  finalRecommendation: DebateFinalRecommendationSchema,
  synthesisMode: z.enum(["best_argument", "arbiter"]),
  meta: z.object({
    warnings: z.array(z.string())
  })
});
export type DebateOutput = z.infer<typeof DebateOutputSchema>;

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

export const WarRoomEventTypeSchema = z.enum([
  "AGENT_ALERT",
  "DEBATE_RESULT",
  "ROUTER_DECISION_REQUIRED",
  "WORKFLOW_STATUS_UPDATE"
]);
export type WarRoomEventType = z.infer<typeof WarRoomEventTypeSchema>;

export const WarRoomEventSchema = z.object({
  id: z.number().int().positive().optional(),
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().optional(),
  type: WarRoomEventTypeSchema,
  timestamp: z.string(),
  payload: z.record(z.any()).default({})
});
export type WarRoomEvent = z.infer<typeof WarRoomEventSchema>;

export const WarRoomDecisionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workflowId: z.string(),
  routerStepId: z.string(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  decision: z.enum(["approve", "reject"]).nullable().optional(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable().optional()
});
export type WarRoomDecision = z.infer<typeof WarRoomDecisionSchema>;

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

export const MetricsModelCallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  success: z.number().int().nonnegative(),
  fallback: z.number().int().nonnegative()
});
export type MetricsModelCall = z.infer<typeof MetricsModelCallSchema>;

export const MetricsOverviewSchema = z.object({
  activeRuns: z.number().int().nonnegative(),
  completedRuns24h: z.number().int().nonnegative(),
  failedRuns24h: z.number().int().nonnegative(),
  approvalQueueDepth: z.number().int().nonnegative(),
  modelCalls24h: z.array(MetricsModelCallSchema),
  meanRunDurationMs: z.number().nonnegative(),
  p95RunDurationMs: z.number().nonnegative(),
  totalOperations: z.number().int().nonnegative(),
  completedOperations: z.number().int().nonnegative(),
  responsesReceived: z.number().int().nonnegative(),
  estimatedApiCredits: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(100)
});
export type MetricsOverview = z.infer<typeof MetricsOverviewSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  status: RunStatusSchema,
  businessSummary: z.string(),
  primaryDecision: z.string().nullable(),
  costImpactUSD: z.number().nullable(),
  riskScore: z.number().nullable(),
  artifacts: z.array(
    z.object({
      type: z.string(),
      stepId: z.string(),
      stepName: z.string(),
      payload: z.any()
    })
  )
});
export type RunResult = z.infer<typeof RunResultSchema>;

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
      "store.list_run_events",
      "store.list_run_steps",
      "store.upsert_run_state",
      "store.upsert_run_step",
      "store.write_output",
      "store.append_run_event",
      "store.create_router_decision",
      "store.resolve_router_decision",
      "store.list_pending_router_decisions",
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
    name: "LLM Agent",
    type: "TASK",
    description: "Executes direct prompt-based LLM steps with provider/model selection.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Debate Agent",
    type: "TASK",
    description: "Runs multi-LLM debate rounds and emits strict recommendation JSON.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {
      debateRounds: 2,
      outputSchemaVersion: "v1",
      requireJson: true
    }
  },
  {
    name: "DatasetLoaderAgent",
    type: "TASK",
    description: "Loads CMAPSS dataset slices for a specific engine unit.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {
      dataset: "dataset",
      source: "local",
      dataset_url: "",
      window: 50
    }
  },
  {
    name: "FeatureBuilderAgent",
    type: "TASK",
    description: "Builds windowed sensor features and anomaly candidates from CMAPSS rows.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {
      window: 50,
      slope_window: 10
    }
  },
  {
    name: "CMAPSS Debate Agent",
    type: "TASK",
    description: "Generates structured root-cause debate output for engine incidents.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "Incident Orchestrator Agent",
    type: "TASK",
    description: "Converts debate output + feature summary into a normalized incident payload.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {}
  },
  {
    name: "DbWriteAgent",
    type: "TASK",
    description: "Persists incident records to Postgres or SQLite.",
    allowlist: ["audit.append_record", "store.write_output"],
    defaultParams: {
      db_target: "postgres"
    }
  },
  {
    name: "Memory Agent",
    type: "TASK",
    description: "Persists and retrieves workflow memory key/value data.",
    allowlist: ["audit.append_record", "store.write_output", "store.set_memory", "store.get_memory"],
    defaultParams: {}
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
    name: "war-room-response",
    description: "Runbook workflow for live War Room supplier risk mitigation.",
    changelog: "Built-in template",
    steps: [
      {
        id: "inventory-scan",
        name: "Inventory Scan",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          toolId: "database",
          query: "SELECT sku, on_hand, reserved, supplier_id FROM inventory WHERE (on_hand - reserved) < 25 ORDER BY sku LIMIT 100",
          prompt: "Detect low-inventory risks and summarize alert severity by supplier."
        }
      },
      {
        id: "risk-detect",
        name: "Detect Risk",
        kind: "AGENT" as const,
        agentName: "Supplier Risk Agent",
        params: {
          confidenceThreshold: 0.65
        }
      },
      {
        id: "multi-model-debate",
        name: "Debate Mitigation Options",
        kind: "AGENT" as const,
        agentName: "Debate Agent",
        params: {
          debateTopic: "Choose the best mitigation plan for supplier and inventory risks",
          debateRounds: 2,
          outputSchemaVersion: "v1",
          requireJson: true
        }
      },
      {
        id: "procurement-router",
        name: "Human Router",
        kind: "ROUTER" as const,
        params: {
          requiresApproval: true,
          reason: "Human approval required before procurement action.",
          routes: [
            {
              label: "Execute Mitigation",
              condition: "variables.routerDecision == 'approve'",
              toNodeId: "execute-mitigation"
            },
            {
              label: "Skip Mitigation",
              condition: "variables.routerDecision == 'reject'",
              toNodeId: "run-summary"
            }
          ],
          defaultRouteToNodeId: "run-summary"
        }
      },
      {
        id: "execute-mitigation",
        name: "Execute Mitigation",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          toolId: "database",
          allowDbWrite: true,
          stopOnReject: false,
          query: "INSERT INTO purchase_orders (id, team_id, vendor_id, part_id, qty, status, created_at, updated_at) VALUES ('{{variables.poId}}', '{{teamId}}', '{{variables.vendorId}}', '{{variables.partId}}', {{variables.qty}}, 'DRAFT', '{{variables.now}}', '{{variables.now}}')",
          prompt: "Create mitigation procurement actions and prepare vendor dispatch updates."
        }
      },
      {
        id: "run-summary",
        name: "Run Summary",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          messageTemplate: "# War Room Summary\n\n{{lastOutput}}"
        }
      }
    ]
  },
  {
    name: "Backorder Resolution",
    description: "Resolve order backorders with cost-aware logistics and approvals.",
    changelog: "Built-in template",
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
    changelog: "Built-in template",
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
  },
  {
    name: "Procurement Scan",
    description: "Scan low inventory and create draft purchase orders with approval gates.",
    changelog: "Built-in template",
    steps: [
      {
        id: "scan-low-inventory",
        name: "Scan Low Inventory",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          toolId: "database",
          query: "SELECT sku, on_hand, reserved FROM inventory WHERE (on_hand - reserved) < 20 ORDER BY sku",
          maxRows: 100,
          prompt: "Summarize inventory risk and propose PO quantity for each row."
        }
      },
      {
        id: "procurement-router",
        name: "Approval Router",
        kind: "ROUTER" as const,
        params: {
          routes: [
            {
              label: "Needs Approval",
              condition: "variables.requiresApproval == true",
              toNodeId: "po-write"
            }
          ],
          defaultRouteToNodeId: "notify-procurement"
        }
      },
      {
        id: "po-write",
        name: "Create Draft PO",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          toolId: "database",
          allowDbWrite: true,
          stopOnReject: false,
          query: "INSERT INTO purchase_orders (id, team_id, vendor_id, part_id, qty, status, created_at, updated_at) VALUES ('{{variables.poId}}', '{{teamId}}', '{{variables.vendorId}}', '{{variables.partId}}', {{variables.qty}}, 'DRAFT', '{{variables.now}}', '{{variables.now}}')",
          prompt: "Confirm draft PO write intent."
        }
      },
      {
        id: "notify-procurement",
        name: "Output Summary",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          messageTemplate: "# Procurement Scan\n\n{{lastOutput}}"
        }
      }
    ]
  }
];

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-haiku-latest",
  gemini: "gemini-2.0-flash"
};
