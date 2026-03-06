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
    name: "Engine Health Incident Demo",
    description: "NASA CMAPSS demo: load engine slice, debate failure mode, route to Decision Console, then publish final summary.",
    changelog: "Built-in template",
    steps: [
      {
        id: "dataset-loader",
        name: "Dataset Loader",
        kind: "AGENT" as const,
        agentName: "DatasetLoaderAgent",
        params: {
          dataset: "FD001",
          dataset_name: "FD001",
          source: "local",
          source_type: "local_or_cached_demo",
          dataset_url: "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data",
          local_path: "./data/CMAPSS/train_FD001.txt",
          unit_id: 12,
          window: 50,
          workflow_name: "engine_health_incident_demo"
        }
      },
      {
        id: "feature-builder",
        name: "Feature Builder",
        kind: "AGENT" as const,
        agentName: "FeatureBuilderAgent",
        params: {
          window: 50,
          slope_window: 10,
          feature_mode: "summary"
        }
      },
      {
        id: "debate",
        name: "Debate",
        kind: "AGENT" as const,
        agentName: "CMAPSS Debate Agent",
        params: {
          debateTopic: "Diagnose probable failure mode using top CMAPSS anomalies.",
          debateRounds: 1,
          synthesisMode: "arbiter",
          roleFraming: ["Mechanical Specialist", "Thermal Specialist", "Controls Specialist"],
          outputSchemaVersion: "v1",
          requireJson: true
        }
      },
      {
        id: "router",
        name: "Router",
        kind: "ROUTER" as const,
        params: {
          requiresApproval: true,
          reason: "Route incident to Decision Console for operator action.",
          routes: [
            {
              label: "Approve Route To Decision Console",
              condition: "variables.routerDecision == 'approve'",
              toNodeId: "decision-console"
            },
            {
              label: "Reject Route To Decision Console",
              condition: "variables.routerDecision == 'reject'",
              toNodeId: "decision-console"
            }
          ],
          defaultRouteToNodeId: "decision-console"
        }
      },
      {
        id: "decision-console",
        name: "Decision Console",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          decision_title: "Engine Health Decision Console",
          recommended_action: "INSPECT",
          decision_options: ["INSPECT", "MONITOR", "ESCALATE"],
          reason: "Debate and anomaly signals indicate likely engine degradation requiring operator action.",
          source_url: "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data",
          dataset_url: "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data",
          supporting_findings: ["primary_issue", "top_anomalies", "hypotheses"],
          messageTemplate:
            "Decision Console: Recommended action INSPECT. Triggered by CMAPSS anomaly and debate findings for unit 12."
        }
      },
      {
        id: "change-gate",
        name: "Make A Change",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "change_gate",
          decision_title: "Engine Health Change Gate"
        }
      },
      {
        id: "output-summary",
        name: "Output",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          source_url: "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data",
          dataset_url: "https://data.nasa.gov/dataset/cmapss-jet-engine-simulated-data",
          recommended_action: "INSPECT",
          messageTemplate:
            "The workflow analyzed FD001 unit 12, identified a likely engine degradation issue, and routed the case to the Decision Console for recommended action."
        }
      }
    ]
  },
  {
    name: "Supply Chain Reorder Risk Demo",
    description: "Kaggle DataCo demo: assess inventory/supplier reorder risk, route recommendation to Decision Console, and output final summary.",
    changelog: "Built-in template",
    steps: [
      {
        id: "supply-loader",
        name: "Supply Loader",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          llmNodeMode: "llm",
          prompt:
            "Use configured demo inputs for SKU INJ-4402 at PLANT-A to summarize stock risk and reorder pressure. Include stock_risk, supplier_risk, and reorder recommendation.",
          workflow_name: "supply_chain_reorder_demo",
          sku_id: "INJ-4402",
          plant_id: "PLANT-A",
          inventory_on_hand: 180,
          reorder_point: 250,
          target_stock: 700,
          source_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          dataset_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          source_type: "local_or_cached_demo",
          local_path: "./data/demo/supply_chain_reorder.csv"
        }
      },
      {
        id: "research-agent",
        name: "Research Agent",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          llmNodeMode: "llm",
          prompt:
            "Generate a concise supply-chain risk brief with stock_risk, supplier_risk, reorder recommendation, and possible actions for operators."
        }
      },
      {
        id: "debate",
        name: "Debate",
        kind: "AGENT" as const,
        agentName: "Debate Agent",
        params: {
          debateTopic:
            "Evaluate reorder options for elevated stockout risk: place standard order, split order, or expedite a partial order.",
          debateRounds: 1,
          synthesisMode: "arbiter",
          outputSchemaVersion: "v1",
          requireJson: true
        }
      },
      {
        id: "router",
        name: "Router",
        kind: "ROUTER" as const,
        params: {
          requiresApproval: true,
          reason: "Route reorder recommendation to Decision Console.",
          routes: [
            {
              label: "Approve Route To Decision Console",
              condition: "variables.routerDecision == 'approve'",
              toNodeId: "decision-console"
            },
            {
              label: "Reject Route To Decision Console",
              condition: "variables.routerDecision == 'reject'",
              toNodeId: "decision-console"
            }
          ],
          defaultRouteToNodeId: "decision-console"
        }
      },
      {
        id: "decision-console",
        name: "Decision Console",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          decision_title: "Supply Chain Decision Console",
          recommended_action: "SPLIT_ORDER",
          decision_options: ["SPLIT_ORDER", "EXPEDITE", "HOLD"],
          reason: "Stockout risk exceeds reorder threshold and supplier delay risk is elevated.",
          source_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          dataset_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          supporting_findings: ["stock_risk", "supplier_risk", "recommended_actions"],
          messageTemplate:
            "Decision Console: Recommended action SPLIT_ORDER. Triggered by elevated stockout and supplier delay risk."
        }
      },
      {
        id: "change-gate",
        name: "Make A Change",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "change_gate",
          decision_title: "Supply Chain Change Gate"
        }
      },
      {
        id: "output-summary",
        name: "Output",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          source_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          dataset_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          recommended_action: "SPLIT_ORDER",
          messageTemplate:
            "The workflow identified elevated stockout risk and routed a reorder recommendation to the Decision Console."
        }
      }
    ]
  },
  {
    name: "Grid Energy Operations Risk Demo",
    description: "Open Power System Data demo: summarize operational stress, debate response, route to Decision Console, and publish output.",
    changelog: "Built-in template",
    steps: [
      {
        id: "dataset-loader",
        name: "Dataset Source Loader",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          llmNodeMode: "llm",
          prompt:
            "Summarize operational stress signals for region DE under scenario high_load_low_renewables and provide key indicators.",
          workflow_name: "energy_operations_risk_demo",
          region: "DE",
          scenario: "high_load_low_renewables",
          date_range: "sample",
          source_url: "https://open-power-system-data.org/",
          dataset_url: "https://open-power-system-data.org/",
          source_type: "local_or_cached_demo",
          local_path: "./data/demo/energy_ops_sample.csv"
        }
      },
      {
        id: "feature-summary",
        name: "Feature Builder",
        kind: "AGENT" as const,
        agentName: "LLM Agent",
        params: {
          llmNodeMode: "llm",
          prompt:
            "Produce a concise feature summary of load stress, renewable deficit, and balancing risk from the prior step context."
        }
      },
      {
        id: "debate",
        name: "Debate",
        kind: "AGENT" as const,
        agentName: "Debate Agent",
        params: {
          debateTopic:
            "Debate the best operational response for grid stress in DE under high load and low renewables.",
          debateRounds: 1,
          synthesisMode: "arbiter",
          roleFraming: ["Operations Specialist", "Grid Stability Specialist", "Cost/Risk Specialist"],
          outputSchemaVersion: "v1",
          requireJson: true
        }
      },
      {
        id: "router",
        name: "Router",
        kind: "ROUTER" as const,
        params: {
          requiresApproval: true,
          reason: "Route energy operations recommendation to Decision Console.",
          routes: [
            {
              label: "Approve Route To Decision Console",
              condition: "variables.routerDecision == 'approve'",
              toNodeId: "decision-console"
            },
            {
              label: "Reject Route To Decision Console",
              condition: "variables.routerDecision == 'reject'",
              toNodeId: "decision-console"
            }
          ],
          defaultRouteToNodeId: "decision-console"
        }
      },
      {
        id: "decision-console",
        name: "Decision Console",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          decision_title: "Energy Operations Decision Console",
          recommended_action: "DISPATCH_RESERVE",
          decision_options: ["MONITOR_GRID", "DISPATCH_RESERVE", "ISSUE_ALERT"],
          reason: "Operational stress scenario indicates reserve dispatch may reduce near-term grid risk.",
          source_url: "https://open-power-system-data.org/",
          dataset_url: "https://open-power-system-data.org/",
          supporting_findings: ["confidence", "finalRecommendation", "recommended_actions"],
          messageTemplate:
            "Decision Console: Recommended action DISPATCH_RESERVE based on debated grid-risk signals."
        }
      },
      {
        id: "change-gate",
        name: "Make A Change",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "change_gate",
          decision_title: "Energy Ops Change Gate"
        }
      },
      {
        id: "output-summary",
        name: "Output",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          source_url: "https://open-power-system-data.org/",
          dataset_url: "https://open-power-system-data.org/",
          recommended_action: "DISPATCH_RESERVE",
          messageTemplate:
            "The workflow reviewed energy operations signals, debated the likely operational risk, and routed the recommended action to the Decision Console."
        }
      }
    ]
  },
  {
    name: "Industrial Quality Manufacturing Incident Demo",
    description: "SECOM-linked manufacturing quality demo: load cached sample, debate incident risk, route to Decision Console, and output summary.",
    changelog: "Built-in template",
    steps: [
      {
        id: "dataset-loader",
        name: "Dataset Loader",
        kind: "AGENT" as const,
        agentName: "DatasetLoaderAgent",
        params: {
          dataset: "FD001",
          dataset_name: "SECOM_demo_cached_proxy",
          source: "local",
          source_type: "local_or_cached_demo",
          dataset_url: "https://archive.ics.uci.edu/ml/datasets/SECOM",
          local_path: "./data/CMAPSS/train_FD001.txt",
          demo_data_note: "Demo uses local cached surrogate rows while referencing the real SECOM source URL.",
          unit_id: 3,
          window: 25,
          batch_id: "BATCH-1042",
          line_id: "LINE-3",
          workflow_name: "manufacturing_quality_incident_demo"
        }
      },
      {
        id: "feature-builder",
        name: "Feature Builder",
        kind: "AGENT" as const,
        agentName: "FeatureBuilderAgent",
        params: {
          window: 25,
          slope_window: 8,
          feature_mode: "summary"
        }
      },
      {
        id: "debate",
        name: "Debate",
        kind: "AGENT" as const,
        agentName: "Debate Agent",
        params: {
          debateTopic:
            "Evaluate whether the batch should be quarantined based on current quality drift and process instability indicators.",
          debateRounds: 1,
          synthesisMode: "arbiter",
          roleFraming: ["Quality Engineer", "Process Engineer", "Maintenance Engineer"],
          outputSchemaVersion: "v1",
          requireJson: true
        }
      },
      {
        id: "router",
        name: "Router",
        kind: "ROUTER" as const,
        params: {
          requiresApproval: true,
          reason: "Route manufacturing incident recommendation to Decision Console.",
          routes: [
            {
              label: "Approve Route To Decision Console",
              condition: "variables.routerDecision == 'approve'",
              toNodeId: "decision-console"
            },
            {
              label: "Reject Route To Decision Console",
              condition: "variables.routerDecision == 'reject'",
              toNodeId: "decision-console"
            }
          ],
          defaultRouteToNodeId: "decision-console"
        }
      },
      {
        id: "decision-console",
        name: "Decision Console",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          decision_title: "Manufacturing Incident Decision Console",
          recommended_action: "QUARANTINE_BATCH",
          decision_options: ["QUARANTINE_BATCH", "RECHECK_PROCESS", "CONTINUE_MONITORING"],
          reason: "Quality-risk signals indicate potential batch impact and process drift.",
          source_url: "https://archive.ics.uci.edu/ml/datasets/SECOM",
          dataset_url: "https://archive.ics.uci.edu/ml/datasets/SECOM",
          supporting_findings: ["primary_issue", "recommended_actions", "confidence"],
          messageTemplate:
            "Decision Console: Recommended action QUARANTINE_BATCH based on debated quality-risk findings."
        }
      },
      {
        id: "change-gate",
        name: "Make A Change",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "change_gate",
          decision_title: "Manufacturing Change Gate"
        }
      },
      {
        id: "output-summary",
        name: "Output",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          outputMode: "run_summary",
          source_url: "https://archive.ics.uci.edu/ml/datasets/SECOM",
          dataset_url: "https://archive.ics.uci.edu/ml/datasets/SECOM",
          recommended_action: "QUARANTINE_BATCH",
          messageTemplate:
            "The workflow identified possible manufacturing quality risk and routed the incident to the Decision Console."
        }
      }
    ]
  },
  {
    name: "asd",
    description: "asd",
    changelog: "Imported from local draft for Git-tracked seeding",
    steps: [
      {
        id: "node_node_6op1amtb",
        name: "Dataset Loader",
        kind: "AGENT" as const,
        agentName: "DatasetLoaderAgent",
        params: {
          label: "Dataset Loader",
          agentName: "DatasetLoaderAgent",
          dataset: "FD001",
          unit_id: 1,
          window: 50,
          source: "download",
          dataset_url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
          cache_dir: "./data/CMAPSS",
          nextStepId: "node_node_44g28g58"
        }
      },
      {
        id: "node_node_44g28g58",
        name: "Feature Builder",
        kind: "AGENT" as const,
        agentName: "FeatureBuilderAgent",
        params: {
          label: "Feature Builder",
          agentName: "FeatureBuilderAgent",
          window: 50,
          slope_window: 10,
          nextStepId: "node_node_t22bt9sn"
        }
      },
      {
        id: "node_node_t22bt9sn",
        name: "Debate",
        kind: "AGENT" as const,
        agentName: "Debate Agent",
        params: {
          label: "Debate",
          agentName: "Debate Agent",
          llmProvider: "openai",
          llmModel: "gpt-4.1-mini",
          debateTopic: "Diagnose probable failure mode using top CMAPSS anomalies.",
          debateRounds: 1,
          outputSchemaVersion: "v1",
          requireJson: true,
          nextStepId: "node_node_y7ymo4ht",
          llmNodeMode: "debate"
        }
      },
      {
        id: "node_node_y7ymo4ht",
        name: "Orchestrator",
        kind: "AGENT" as const,
        agentName: "Incident Orchestrator Agent",
        params: {
          label: "Orchestrator",
          agentName: "Incident Orchestrator Agent",
          llmProvider: "openai",
          llmModel: "gpt-4.1-mini",
          prompt:
            "You are an enterprise maintenance orchestrator. Convert the analysis into a structured incident record for a maintenance database. Keep it concise, operational, and audit-friendly.",
          nextStepId: "node_node_95f5xmke",
          llmNodeMode: "llm"
        }
      },
      {
        id: "node_node_95f5xmke",
        name: "DB Write",
        kind: "AGENT" as const,
        agentName: "DbWriteAgent",
        params: {
          label: "DB Write",
          agentName: "DbWriteAgent",
          db_target: "postgres",
          sqlite_path: "",
          nextStepId: "node_node_1x9l75h1",
          connectionString: "postgresql://admin:admin@localhost:5432/workflowdb"
        }
      },
      {
        id: "node_node_1x9l75h1",
        name: "Output",
        kind: "AGENT" as const,
        agentName: "Notification Agent",
        params: {
          label: "Output",
          outputMode: "run_summary",
          messageTemplate: "# CMAPSS Incident Result\n\n{{lastOutput}}",
          includeContext: false
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
