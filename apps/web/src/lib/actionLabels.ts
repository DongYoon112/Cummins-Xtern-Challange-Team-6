const ACTION_LABELS: Record<string, string> = {
  DISPATCH_RESERVE: "Dispatch reserve capacity now",
  MONITOR_GRID: "Monitor grid conditions",
  ISSUE_ALERT: "Issue an operational alert",
  CONTINUE_MONITORING: "Continue monitoring",
  RECHECK_PROCESS: "Recheck process settings",
  QUARANTINE_BATCH: "Quarantine affected batch",
  SPLIT_ORDER: "Split the order",
  EXPEDITE: "Expedite execution",
  ESCALATE: "Escalate to operations lead",
  MONITOR: "Monitor conditions"
};

export function humanizeActionLabel(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "_");
  return ACTION_LABELS[normalized] ?? value;
}
