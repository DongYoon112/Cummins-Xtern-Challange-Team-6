import type { RunState, WarRoomEvent } from "@agentfoundry/shared";
import { callMcpTool } from "../lib/mcpClient";

export type RunEvent = {
  runId: string;
  ts: string;
  kind: string;
  stepId?: string;
  title: string;
  data: unknown;
};

export async function getRun(runId: string): Promise<RunState | null> {
  const payload = await callMcpTool<{ runId: string }, { run: RunState | null }>("store", "get_run", { runId });
  return payload.run;
}

export async function listEvents(runId: string): Promise<RunEvent[]> {
  const payload = await callMcpTool<{ runId: string; limit: number }, { events: WarRoomEvent[] }>("store", "list_run_events", {
    runId,
    limit: 1000
  });
  return payload.events.map((event) => ({
    runId: event.runId,
    ts: event.timestamp,
    kind: event.type,
    stepId: event.stepId,
    title: event.type,
    data: event.payload
  }));
}
