import { Router } from "express";
import type { RunState, WarRoomEvent, WarRoomDecision } from "@agentfoundry/shared";
import { z } from "zod";
import { orchestrator } from "../agents/orchestrator";
import { callMcpTool } from "../lib/mcpClient";

const router = Router();

const startSchema = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.number().int().positive().optional(),
  inputContext: z.record(z.any()).optional()
});

const decisionSchema = z.object({
  runId: z.string().min(1),
  routerStepId: z.string().min(1),
  decision: z.enum(["approve", "reject"])
});

const runControlSchema = z.object({
  runId: z.string().min(1)
});

async function buildWarRoomSnapshot(runId: string, teamId: string) {
  const [eventsPayload, stepsPayload, decisionPayload, run] = await Promise.all([
    callMcpTool<{ runId: string; limit: number }, { events: WarRoomEvent[] }>("store", "list_run_events", { runId, limit: 1000 }),
    callMcpTool<{ runId: string }, { steps: Array<Record<string, unknown>> }>("store", "list_run_steps", { runId }),
    callMcpTool<{ runId: string }, { decisions: WarRoomDecision[] }>("store", "list_pending_router_decisions", { runId }),
    orchestrator.getRun(runId, teamId)
  ]);

  const activeSteps = stepsPayload.steps.filter((step) => step.status === "RUNNING" || step.status === "WAITING_APPROVAL");

  return {
    run: run
      ? {
          runId: run.runId,
          workflowId: run.workflowId,
          status: run.status,
          pauseRequested: (run.context as { variables?: { pauseRequested?: boolean } } | undefined)?.variables?.pauseRequested === true
        }
      : null,
    events: eventsPayload.events,
    runSteps: stepsPayload.steps,
    activeSteps,
    pendingDecisions: decisionPayload.decisions
  };
}

router.post("/start", async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid start payload", details: parsed.error.flatten() });
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

    const snapshot = await buildWarRoomSnapshot(run.runId, req.user!.teamId);
    res.status(201).json({
      runId: run.runId,
      workflowId: run.workflowId,
      status: run.status,
      ...snapshot
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to start War Room run";
    if (message.includes("Workflow version not found")) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.startsWith("Allowlist violation:")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

router.get("/:runId/events", async (req, res) => {
  try {
    const snapshot = await buildWarRoomSnapshot(req.params.runId, req.user!.teamId);
    if (!snapshot.run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json(snapshot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load War Room events" });
  }
});

router.post("/decision", async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.decideRouterDecision({
      runId: parsed.data.runId,
      routerStepId: parsed.data.routerStepId,
      decision: parsed.data.decision,
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      }
    });

    const snapshot = await buildWarRoomSnapshot(run.runId, req.user!.teamId);
    res.json(snapshot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process War Room decision" });
  }
});

router.post("/pause", async (req, res) => {
  const parsed = runControlSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pause payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.pauseRun({
      runId: parsed.data.runId,
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      }
    });
    const snapshot = await buildWarRoomSnapshot(run.runId, req.user!.teamId);
    res.json(snapshot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to pause run" });
  }
});

router.post("/resume", async (req, res) => {
  const parsed = runControlSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid resume payload", details: parsed.error.flatten() });
    return;
  }

  try {
    const run = await orchestrator.resumeRun({
      runId: parsed.data.runId,
      actor: {
        userId: req.user!.id,
        username: req.user!.username,
        teamId: req.user!.teamId
      }
    });
    const snapshot = await buildWarRoomSnapshot(run.runId, req.user!.teamId);
    res.json(snapshot);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Failed to resume run";
    if (message.startsWith("Cannot resume:")) {
      res.status(409).json({ error: message });
      return;
    }
    res.status(500).json({ error: "Failed to resume run" });
  }
});

router.get("/:runId/stream", async (req, res) => {
  const run = await orchestrator.getRun(req.params.runId, req.user!.teamId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let lastEventId = 0;
  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const writeFrame = (event: string, payload: unknown) => {
    if (closed) {
      return;
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeFrame("ready", {
    runId: req.params.runId,
    timestamp: new Date().toISOString()
  });

  const poll = async () => {
    if (closed) {
      return;
    }
    try {
      const payload = await callMcpTool<{ runId: string; sinceId?: number; limit: number }, { events: WarRoomEvent[] }>(
        "store",
        "list_run_events",
        {
          runId: req.params.runId,
          sinceId: lastEventId > 0 ? lastEventId : undefined,
          limit: 200
        }
      );
      for (const event of payload.events) {
        if (typeof event.id === "number") {
          lastEventId = event.id;
        }
        writeFrame("event", event);
      }
    } catch (error) {
      writeFrame("error", { message: error instanceof Error ? error.message : "stream_error" });
    }
  };

  await poll();
  const timer = setInterval(() => {
    poll().catch(() => undefined);
  }, 1000);

  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(": ping\n\n");
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    res.end();
  });
});

export { router as warRoomRouter };
