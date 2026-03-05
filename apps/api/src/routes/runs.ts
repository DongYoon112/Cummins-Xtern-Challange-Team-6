import { Router } from "express";
import { z } from "zod";
import { appendEvent, createRun, getRun, listEvents, type RunEvent } from "../store/runStore";

const router = Router();

const createRunSchema = z.object({
  draftWorkflow: z.any()
});

const decisionSchema = z.object({
  actionId: z.string().min(1),
  decision: z.enum(["approve", "reject", "more_evidence"]),
  rationale: z.string().optional()
});

function syntheticEvents(runId: string, draftWorkflow: any): RunEvent[] {
  const baseMs = Date.now();
  const at = (index: number) => new Date(baseMs + index * 900).toISOString();

  return [
    {
      runId,
      ts: at(0),
      kind: "ingest",
      title: "Workflow draft ingested",
      data: {
        draftWorkflow,
        source: "builder-draft"
      }
    },
    {
      runId,
      ts: at(1),
      kind: "step_start",
      stepId: "situation-assessment",
      title: "Step started: Situation Assessment",
      data: {
        worker: "triage-agent"
      }
    },
    {
      runId,
      ts: at(2),
      kind: "step_done",
      stepId: "situation-assessment",
      title: "Step complete: Situation Assessment",
      data: {
        latencyMs: 620,
        cost: 0.18
      }
    },
    {
      runId,
      ts: at(3),
      kind: "step_start",
      stepId: "impact-analysis",
      title: "Step started: Impact Analysis",
      data: {
        worker: "analysis-agent"
      }
    },
    {
      runId,
      ts: at(4),
      kind: "step_done",
      stepId: "impact-analysis",
      title: "Step complete: Impact Analysis",
      data: {
        latencyMs: 970,
        cost: 0.26
      }
    },
    {
      runId,
      ts: at(5),
      kind: "debate",
      stepId: "option-debate",
      title: "Debate complete: Supplier response strategy",
      data: {
        topic: "Choose the best supplier response strategy under delay risk",
        rounds: 2,
        participants: [
          { provider: "openai", model: "gpt-4.1-mini", stance: "cost-first" },
          { provider: "anthropic", model: "claude-3-5-sonnet-latest", stance: "risk-first" },
          { provider: "gemini", model: "gemini-2.0-flash", stance: "balanced" }
        ],
        arguments: [
          {
            provider: "openai",
            model: "gpt-4.1-mini",
            summary: "Use dual-source with staged allocation to minimize immediate spend.",
            rationale: "Keeps short-term cost down while preserving optionality.",
            confidence: 0.74
          },
          {
            provider: "anthropic",
            model: "claude-3-5-sonnet-latest",
            summary: "Prioritize reliable supplier and expedite critical SKUs only.",
            rationale: "Reduces line-down risk for tier-A demand.",
            confidence: 0.81
          },
          {
            provider: "gemini",
            model: "gemini-2.0-flash",
            summary: "Blend both: protect tier-A demand and limit expedite volume.",
            rationale: "Balances cost and resilience.",
            confidence: 0.78
          }
        ],
        finalRecommendation: "Approve blended strategy with tier-A expedite cap.",
        synthesisMode: "llm",
        latencyMs: 1210,
        cost: 0.39
      }
    },
    {
      runId,
      ts: at(6),
      kind: "finding",
      title: "Critical supplier delay detected",
      data: {
        severity: "high",
        riskScore: 78,
        trend: "up",
        drivers: ["supplier_a_eta_slip", "inventory_buffer_under_2_days"],
        latencyMs: 410,
        cost: 0.09
      }
    },
    {
      runId,
      ts: at(7),
      kind: "recommendation",
      title: "Recommended response plan",
      data: {
        summary: "Mitigate line-stop risk within 24h while controlling expedite spend.",
        actions: [
          {
            actionId: "reroute_supplier_b",
            title: "Reroute 30% volume to Supplier B",
            evidence_refs: ["PO-8842", "Supplier B capacity report"]
          },
          {
            actionId: "approve_expedite",
            title: "Approve expedite shipment for critical SKUs",
            evidence_refs: ["SKU criticality matrix", "Carrier quote 2026-03-04"]
          },
          {
            actionId: "freeze_low_priority",
            title: "Pause low-priority allocations for 48 hours",
            evidence_refs: ["production schedule v17", "demand forecast week 10"]
          }
        ],
        latencyMs: 530,
        cost: 0.14
      }
    }
  ];
}

router.post("/", (req, res) => {
  const parsed = createRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid run payload", details: parsed.error.flatten() });
    return;
  }

  const runId = createRun(parsed.data.draftWorkflow);
  const events = syntheticEvents(runId, parsed.data.draftWorkflow);
  events.forEach((event) => {
    appendEvent(runId, event);
  });

  res.status(201).json({ runId });
});

router.get("/:runId/events", (req, res) => {
  const events = listEvents(req.params.runId);
  if (!events) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json(events);
});

router.post("/:runId/decisions", (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision payload", details: parsed.error.flatten() });
    return;
  }

  if (!getRun(req.params.runId)) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const upper = parsed.data.decision.toUpperCase();
  appendEvent(req.params.runId, {
    ts: new Date().toISOString(),
    kind: "decision",
    title: `Decision: ${upper} ${parsed.data.actionId}`,
    data: {
      actionId: parsed.data.actionId,
      decision: parsed.data.decision,
      rationale: parsed.data.rationale ?? null
    }
  });

  res.json({ ok: true });
});

export { router as runsRouter };
