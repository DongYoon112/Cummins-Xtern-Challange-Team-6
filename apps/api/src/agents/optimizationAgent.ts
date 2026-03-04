import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import type { AuditRecord } from "@agentfoundry/shared";

export function createOptimizationProposal(params: {
  teamId: string;
  workflowId: string;
  runId: string;
  records: AuditRecord[];
}) {
  const { teamId, workflowId, runId, records } = params;

  const lowConfidence = records.filter((record) => record.confidence < 0.6);
  const approvalActions = records.filter((record) =>
    record.rationale.toLowerCase().includes("approval")
  );

  const byAgent = new Map<string, number>();
  for (const record of records) {
    byAgent.set(record.agentName, (byAgent.get(record.agentName) ?? 0) + 1);
  }

  const topAgent = Array.from(byAgent.entries()).sort((a, b) => b[1] - a[1])[0];

  const proposal = {
    title: `PR Proposal: tighten thresholds for workflow ${workflowId}`,
    summary:
      "Optimization Agent reviewed audit traces and proposes a non-breaking workflow update for manual review.",
    findings: {
      totalRecords: records.length,
      lowConfidenceCount: lowConfidence.length,
      approvalRelatedCount: approvalActions.length,
      busiestAgent: topAgent ? { agentName: topAgent[0], actions: topAgent[1] } : null
    },
    changes: [
      "Add explicit confidenceThreshold param to every Finance and Supplier Risk step.",
      "Insert an Approval node before high-cost Finance actions when costImpactUSD trends exceed 500.",
      "Refine step params for Logistics to include destination region fallback for deterministic routing."
    ],
    autoApplied: false
  };

  const id = `opt_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO optimization_proposals (id, team_id, workflow_id, run_id, title, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(id, teamId, workflowId, runId, proposal.title, JSON.stringify(proposal), "PROPOSED", createdAt);

  return {
    id,
    ...proposal,
    createdAt
  };
}