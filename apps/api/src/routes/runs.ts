import { Router } from "express";
import type { WarRoomEvent } from "@agentfoundry/shared";
import { z } from "zod";
import { orchestrator } from "../agents/orchestrator";
import { callMcpTool } from "../lib/mcpClient";

const router = Router();

const createRunSchema = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().positive().optional()
});

const decisionSchema = z.object({
  routerStepId: z.string().min(1),
  decision: z.enum(["approve", "reject"])
});

router.post("/", async (req, res) => {
  const parsed = createRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid run payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.startRun({
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      },
      workflowId: parsed.data.workflowId,
      workflowVersion: parsed.data.workflowVersion
    });
    res.status(201).json({ runId: run.runId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to start run" });
  }
});

router.get("/:runId/events", async (req, res) => {
  try {
    const run = await orchestrator.getRun(req.params.runId, req.user!.teamId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const payload = await callMcpTool<{ runId: string; limit: number }, { events: WarRoomEvent[] }>("store", "list_run_events", {
      runId: req.params.runId,
      limit: 1000
    });

    const legacyEvents = payload.events.map((event) => ({
      runId: event.runId,
      ts: event.timestamp,
      kind: event.type.toLowerCase(),
      stepId: event.stepId,
      title: event.type,
      data: event.payload
    }));
    res.json(legacyEvents);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load run events" });
  }
});

router.post("/:runId/decisions", async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.decideRouterDecision({
      runId: req.params.runId,
      routerStepId: parsed.data.routerStepId,
      decision: parsed.data.decision,
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      }
    });
    res.json({ ok: true, runId: run.runId, status: run.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process decision" });
  }
});

export { router as runsRouter };
