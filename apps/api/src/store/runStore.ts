import { randomUUID } from "node:crypto";

export type RunEvent = {
  runId: string;
  ts: string;
  kind:
    | "ingest"
    | "step_start"
    | "step_done"
    | "debate"
    | "finding"
    | "recommendation"
    | "decision"
    | "action"
    | "error";
  stepId?: string;
  title: string;
  data: any;
};

type StoredRun = {
  runId: string;
  createdAt: string;
  draftWorkflow: any;
  events: RunEvent[];
};

const runMap = new Map<string, StoredRun>();

export function createRun(draftWorkflow: any) {
  const runId = randomUUID();
  runMap.set(runId, {
    runId,
    createdAt: new Date().toISOString(),
    draftWorkflow,
    events: []
  });
  return runId;
}

export function getRun(runId: string) {
  return runMap.get(runId);
}

export function appendEvent(
  runId: string,
  event: Omit<RunEvent, "runId"> | RunEvent
) {
  const run = runMap.get(runId);
  if (!run) {
    return null;
  }

  const nextEvent: RunEvent =
    "runId" in event
      ? { ...event, runId }
      : {
          ...event,
          runId
        };

  run.events.push(nextEvent);
  return nextEvent;
}

export function listEvents(runId: string) {
  const run = runMap.get(runId);
  if (!run) {
    return null;
  }

  return [...run.events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
