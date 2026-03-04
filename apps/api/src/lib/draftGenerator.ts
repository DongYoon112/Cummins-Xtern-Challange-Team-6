import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Provider } from "@agentfoundry/shared";
import { DEFAULT_MODELS } from "@agentfoundry/shared";
import type { ServerTeamSettings } from "./settings";
import { askProviderForObject } from "./providers";

const ToolConfigSchema = z.record(z.any());

const NodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["start", "llm", "tool", "router", "memory", "output"]),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.any()).default({})
});

const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1)
});

const DraftGraphSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  meta: z
    .object({
      generatedBy: z.string().optional(),
      generatedAt: z.string().optional()
    })
    .optional()
});

const PlanStepSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(["llm", "tool", "memory", "router", "approval", "output"]),
  name: z.string().min(1),
  toolHint: z.string().optional(),
  riskyAction: z.string().optional(),
  params: z.record(z.any()).default({})
});

const PlanSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1).max(50),
  notes: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([])
});

export const DraftGenerateInputSchema = z.object({
  prompt: z.string().min(1),
  currentConfig: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      agentType: z.string().min(1),
      llmProvider: z.string().min(1),
      llmModel: z.string().min(1),
      tools: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          category: z.string().min(1),
          enabled: z.boolean(),
          config: ToolConfigSchema
        })
      ),
      graph: DraftGraphSchema.optional()
    })
    .optional(),
  feedback: z.string().optional(),
  constraints: z
    .object({
      goalTemplate: z.enum(["ops_runbook", "research_memo", "data_analysis", "code_helper"]).optional(),
      allowedTools: z.array(z.string()).default([]),
      requireApprovalsFor: z.array(z.string()).default([]),
      provider: z.enum(["openai", "anthropic", "gemini"]).optional(),
      riskLevel: z.enum(["low", "medium", "high"]).optional(),
      budget: z
        .object({
          maxSteps: z.number().int().positive().max(50).optional()
        })
        .optional()
    })
    .default({})
});

type DraftGenerateInput = z.infer<typeof DraftGenerateInputSchema>;

const TOOL_DEFINITIONS = [
  {
    id: "web_search",
    label: "Web search",
    category: "Discovery",
    defaultConfig: { baseUrl: "https://api.search.local", scopes: ["news", "docs"], rateLimitPerMin: 30 }
  },
  {
    id: "http_requests",
    label: "HTTP requests",
    category: "Integration",
    defaultConfig: { baseUrl: "https://api.example.com", scopes: ["read"], rateLimitPerMin: 60 }
  },
  {
    id: "filesystem",
    label: "Filesystem (read/write)",
    category: "System",
    defaultConfig: { allowRead: true, allowWrite: false, scopes: ["./data"] }
  },
  {
    id: "database",
    label: "Database",
    category: "Data",
    defaultConfig: { connectionString: "postgres://localhost:5432/app", scopes: ["read"], rateLimitPerMin: 120 }
  },
  {
    id: "calendar_email",
    label: "Calendar/Email (stub)",
    category: "Communication",
    defaultConfig: { isStub: true, scopes: ["calendar.read", "email.send"] }
  },
  {
    id: "code_execution",
    label: "Code execution (sandboxed)",
    category: "System",
    defaultConfig: { sandboxProfile: "restricted", rateLimitPerMin: 10 }
  },
  {
    id: "vector_store",
    label: "Vector store (stub)",
    category: "AI",
    defaultConfig: { isStub: true, indexName: "agentfoundry-default" }
  }
] as const;

function mapAllowedTool(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["web", "web_search", "search", "browse"].includes(normalized)) {
    return "web_search";
  }
  if (["http", "http_get", "http_post", "api", "requests"].includes(normalized)) {
    return "http_requests";
  }
  if (["db", "db_read", "database", "sql"].includes(normalized)) {
    return "database";
  }
  if (["file_write", "filesystem", "fs"].includes(normalized)) {
    return "filesystem";
  }
  if (["email", "calendar", "email_send", "messaging"].includes(normalized)) {
    return "calendar_email";
  }
  if (["code", "code_execution", "sandbox"].includes(normalized)) {
    return "code_execution";
  }
  if (["vector", "vector_store", "rag"].includes(normalized)) {
    return "vector_store";
  }
  return null;
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function heuristicPlan(input: DraftGenerateInput) {
  const nameBase = input.prompt.slice(0, 48).trim() || "AI Generated Workflow";
  const title = nameBase.length > 42 ? `${nameBase.slice(0, 42)}...` : nameBase;
  const risks: string[] = [];
  const notes: string[] = [];
  const steps: Array<z.infer<typeof PlanStepSchema>> = [
    {
      type: "llm",
      name: "Clarify Request",
      params: { objective: input.prompt }
    }
  ];

  const allowedToolIds = new Set(input.constraints.allowedTools.map(mapAllowedTool).filter(Boolean));
  if (allowedToolIds.has("web_search")) {
    steps.push({
      type: "tool",
      name: "Collect Web Sources",
      toolHint: "web_search",
      params: { query: input.prompt }
    });
  }
  if (allowedToolIds.has("database")) {
    steps.push({
      type: "tool",
      name: "Read Database Facts",
      toolHint: "database",
      params: { mode: "read_only" }
    });
    notes.push("needs DB connection string");
  }
  if (allowedToolIds.has("http_requests")) {
    steps.push({
      type: "tool",
      name: "Call External API",
      toolHint: "http_requests",
      riskyAction: "http_post",
      params: { method: "POST", endpoint: "https://api.example.com/tasks" }
    });
    risks.push("contains external HTTP POST");
  }

  steps.push({
    type: "llm",
    name: "Summarize and Decide",
    params: { format: "brief" }
  });

  steps.push({
    type: "output",
    name: "Output Result",
    params: { format: "markdown" }
  });

  return PlanSchema.parse({
    name: `AI Draft: ${title}`,
    description: `Generated from prompt: ${input.prompt}`,
    steps,
    notes,
    risks
  });
}

function applyRiskPolicies(
  steps: Array<z.infer<typeof PlanStepSchema>>,
  requireApprovalsFor: string[],
  riskLevel: "low" | "medium" | "high" | undefined
) {
  const normalizedPolicies = new Set(requireApprovalsFor.map((item) => item.trim().toLowerCase()));
  const next = [...steps];

  const hasDangerousStep = next.some((step) => {
    const risky = (step.riskyAction ?? step.toolHint ?? "").toLowerCase();
    return risky && normalizedPolicies.has(risky);
  });

  const mustInsertApproval = hasDangerousStep || riskLevel === "high";
  if (!mustInsertApproval) {
    return next;
  }

  const outputIndex = next.findIndex((step) => step.type === "output");
  const approvalStep: z.infer<typeof PlanStepSchema> = {
    type: "approval",
    name: "Approval Gate",
    params: { reason: "Risky action requires approval" }
  };

  if (outputIndex === -1) {
    next.push(approvalStep);
    return next;
  }

  const existingApprovalBeforeOutput = next.slice(0, outputIndex).some((step) => step.type === "approval");
  if (!existingApprovalBeforeOutput) {
    next.splice(outputIndex, 0, approvalStep);
  }
  return next;
}

function planToGraph(plan: z.infer<typeof PlanSchema>, input: DraftGenerateInput) {
  const maxSteps = input.constraints.budget?.maxSteps ?? 25;
  const baseSteps = plan.steps.slice(0, maxSteps);
  const steps = applyRiskPolicies(baseSteps, input.constraints.requireApprovalsFor, input.constraints.riskLevel);

  const nodes: z.infer<typeof NodeSchema>[] = [];
  const edges: z.infer<typeof EdgeSchema>[] = [];

  const startId = makeId("node");
  nodes.push({
    id: startId,
    type: "start",
    position: { x: 120, y: 180 },
    config: { label: "Start" }
  });

  let previous = startId;
  steps.forEach((step, index) => {
    const id = step.id ?? makeId("node");
    const type =
      step.type === "approval"
        ? "router"
        : step.type === "tool"
          ? "tool"
          : step.type === "memory"
            ? "memory"
            : step.type === "output"
              ? "output"
              : step.type === "router"
                ? "router"
                : "llm";

    const x = 120 + (index + 1) * 240;
    const y = 180;
    nodes.push({
      id,
      type,
      position: { x, y },
      config: {
        label: step.name,
        toolHint: step.toolHint,
        riskyAction: step.riskyAction,
        ...step.params
      }
    });
    edges.push({
      id: makeId("edge"),
      source: previous,
      target: id
    });
    previous = id;
  });

  return DraftGraphSchema.parse({
    nodes,
    edges,
    meta: {
      generatedBy: "ai-builder",
      generatedAt: new Date().toISOString()
    }
  });
}

async function generatePlanWithModel(input: DraftGenerateInput, teamSettings: ServerTeamSettings) {
  const provider: Provider = input.constraints.provider ?? teamSettings.defaultProvider;
  const model = provider === teamSettings.defaultProvider ? teamSettings.defaultModel : DEFAULT_MODELS[provider];
  const apiKey = teamSettings.keys[provider];

  if (!apiKey) {
    return null;
  }

  const systemPrompt =
    "Return strict JSON only. Output keys: name, description, steps, notes, risks. " +
    "steps[] item keys: type(llm|tool|memory|router|approval|output), name, optional toolHint, optional riskyAction, params(object).";

  let correction = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = [
      `User prompt: ${input.prompt}`,
      `Goal template: ${input.constraints.goalTemplate ?? "none"}`,
      `Allowed tools: ${input.constraints.allowedTools.join(", ") || "none"}`,
      `Risk level: ${input.constraints.riskLevel ?? "medium"}`,
      `Require approvals for: ${input.constraints.requireApprovalsFor.join(", ") || "none"}`,
      `Budget maxSteps: ${input.constraints.budget?.maxSteps ?? 25}`,
      input.feedback ? `Refinement feedback: ${input.feedback}` : "",
      input.currentConfig ? `Current draft summary: ${JSON.stringify({ name: input.currentConfig.name, description: input.currentConfig.description })}` : "",
      correction
    ]
      .filter(Boolean)
      .join("\n");

    const raw = await askProviderForObject({
      provider,
      model,
      apiKey,
      systemPrompt,
      prompt,
      maxTokens: 1400
    });

    if (!raw) {
      correction = "Previous output was invalid or empty. Return valid JSON object only.";
      continue;
    }

    const parsed = PlanSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }

    correction = `Validation errors: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`;
  }

  return null;
}

function buildTools(allowed: string[]) {
  const enabled = new Set(allowed.map(mapAllowedTool).filter(Boolean));
  return TOOL_DEFINITIONS.map((tool) => ({
    id: tool.id,
    label: tool.label,
    category: tool.category,
    enabled: enabled.size === 0 ? false : enabled.has(tool.id),
    config: { ...tool.defaultConfig }
  }));
}

export async function generateWorkflowDraft(input: DraftGenerateInput, teamSettings: ServerTeamSettings) {
  const provider: Provider = input.constraints.provider ?? teamSettings.defaultProvider;
  const plan = (await generatePlanWithModel(input, teamSettings)) ?? heuristicPlan(input);
  const graph = planToGraph(plan, input);

  const notes = [...plan.notes];
  const risks = [...plan.risks];
  if (!teamSettings.keys[provider]) {
    notes.push(`missing key: ${provider.toUpperCase()}_API_KEY`);
  }
  if (graph.nodes.some((node) => node.type === "router" && String(node.config.label).toLowerCase().includes("approval"))) {
    risks.push("approval gate inserted before risky action");
  }
  if (input.constraints.allowedTools.some((tool) => mapAllowedTool(tool) === "database")) {
    notes.push("needs DB connection string");
  }

  const draftId = input.currentConfig?.id ?? `wf_${randomUUID()}`;
  const llmProvider = provider;
  const llmModel = provider === teamSettings.defaultProvider ? teamSettings.defaultModel : DEFAULT_MODELS[provider];
  return {
    draft: {
      id: draftId,
      name: plan.name,
      config: {
        id: draftId,
        name: plan.name,
        description: plan.description,
        agentType: "Orchestrator",
        llmProvider,
        llmModel,
        tools: input.currentConfig?.tools ?? buildTools(input.constraints.allowedTools),
        graph
      }
    },
    notes: Array.from(new Set(notes)),
    risks: Array.from(new Set(risks))
  };
}

