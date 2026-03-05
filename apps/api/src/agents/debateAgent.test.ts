import test from "node:test";
import assert from "node:assert/strict";
import type { ServerTeamSettings } from "../lib/settings";
import { DebateOutputSchema } from "@agentfoundry/shared";
import { runTaskAgent } from "./taskAgents";

const baseTeamSettings: ServerTeamSettings = {
  teamId: "team-default",
  defaultProvider: "openai",
  defaultModel: "gpt-4.1-mini",
  keys: {
    openai: undefined,
    anthropic: undefined,
    gemini: undefined
  }
};

test("Debate Agent returns strict output contract when providers succeed", async () => {
  const result = await runTaskAgent({
    agentName: "Debate Agent",
    stepParams: {
      debateTopic: "Should we approve mitigation plan A?",
      debateRounds: 2,
      participants: [
        { id: "risk", label: "Risk Analyst", provider: "openai", model: "gpt-4o-mini", stance: "BLOCK" },
        { id: "cost", label: "Cost Optimizer", provider: "anthropic", model: "claude-3-5-sonnet", stance: "APPROVE" },
        { id: "ops", label: "Ops Reliability", provider: "gemini", model: "gemini-1.5-pro", stance: "CONDITIONAL" }
      ],
      arbiter: { enabled: true, provider: "openai", model: "gpt-4o-mini" }
    },
    runContext: {
      runId: "run_test",
      workflowId: "wf_test",
      variables: {}
    },
    teamSettings: {
      ...baseTeamSettings,
      keys: {
        openai: "mock://strict-success",
        anthropic: "mock://strict-success",
        gemini: "mock://strict-success"
      }
    }
  });

  const parsed = DebateOutputSchema.parse(result.output);
  assert.equal(parsed.schemaVersion, "v1");
  assert.equal(parsed.rounds, 2);
  assert.equal(parsed.arguments.length, 6);
  assert.equal(parsed.synthesisMode, "arbiter");
  assert.ok(parsed.finalRecommendation.confidence >= 0 && parsed.finalRecommendation.confidence <= 1);
});

test("Debate Agent returns fallback contract when provider keys are missing", async () => {
  const result = await runTaskAgent({
    agentName: "Debate Agent",
    stepParams: {
      debateTopic: "Fallback behavior check",
      debateRounds: 2
    },
    runContext: {
      runId: "run_test",
      workflowId: "wf_test",
      variables: {}
    },
    teamSettings: baseTeamSettings
  });

  const parsed = DebateOutputSchema.parse(result.output);
  assert.equal(parsed.rounds, 2);
  assert.equal(parsed.participants.length, 3);
  assert.ok(parsed.arguments.length >= 3);
  assert.ok(parsed.meta.warnings.length > 0);
  assert.equal(result.mockMode, true);
});

test("Debate Agent falls back to best_argument when arbiter is missing", async () => {
  const result = await runTaskAgent({
    agentName: "Debate Agent",
    stepParams: {
      debateTopic: "Arbiter fallback check",
      debateRounds: 1,
      participants: [
        { id: "risk", label: "Risk Analyst", provider: "openai", model: "gpt-4o-mini", stance: "BLOCK", weight: 2 }
      ],
      arbiter: {
        enabled: true,
        provider: "anthropic",
        model: "claude-3-5-sonnet"
      }
    },
    runContext: {
      runId: "run_test",
      workflowId: "wf_test",
      variables: {}
    },
    teamSettings: {
      ...baseTeamSettings,
      keys: { openai: "mock://strict-success", anthropic: undefined, gemini: undefined }
    }
  });

  const parsed = DebateOutputSchema.parse(result.output);
  assert.equal(parsed.synthesisMode, "best_argument");
  assert.equal(parsed.finalRecommendation.decision, "BLOCK");
  assert.ok(parsed.meta.warnings.length > 0);
});
