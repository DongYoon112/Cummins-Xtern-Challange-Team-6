# AgentFoundry MVP

AgentFoundry is a monorepo starter for governed multi-agent workflow execution in supply chain/manufacturing domains.

## What is included

- React web app with tabs: `Workflows`, `Runs`, `Approvals`, `Audit Log`, `Settings`
- Express API gateway with:
  - Local auth (username/password) + RBAC
  - Workflow versioning/forking
  - Run orchestration + pause/resume approvals
  - Provider settings (OpenAI, Anthropic, Gemini) with encrypted key storage
- Real MCP-based persistence via 3 Streamable HTTP servers:
  - `mcp-registry` (workflow repo + agent catalog)
  - `mcp-store` (run state + outputs)
  - `mcp-audit` (append-only decision logs)
- SQLite persistence via `better-sqlite3`
- Built-in templates seeded at startup:
  - Backorder Resolution
  - Supplier Risk Check
- Seeded synthetic datasets:
  - `inventory`, `suppliers`, `orders`, `shipping_rates`

## Architecture (ASCII)

```text
+-----------------------+              +------------------------+
|      React Web        | <----------> |      API Gateway       |
|  tabs + RBAC UI       |   HTTP/JSON  | auth, RBAC, orchestrator|
+-----------------------+              +-----------+------------+
                                                   |
                                                   | MCP Client (TS SDK)
                                                   v
                         +----------------+   +----------------+   +----------------+
                         | Registry MCP   |   | Store MCP      |   | Audit MCP      |
                         | workflows      |   | runs/outputs   |   | append/query   |
                         +--------+-------+   +--------+-------+   +--------+-------+
                                  \                 |                        /
                                   \                |                       /
                                    +---------------------------------------+
                                    |      SQLite (single shared file)      |
                                    +---------------------------------------+
```

## Monorepo layout

```text
apps/
  web/            React + Vite + Tailwind
  api/            Express API + Orchestrator + Agents
  mcp-registry/   MCP server for workflow registry/catalog
  mcp-store/      MCP server for run state persistence
  mcp-audit/      MCP server for audit records
packages/
  shared/         zod schemas + shared types/templates
  crypto/         AES-256-GCM encryption helpers
examples/
  decision-log.json
```

## Prerequisites

- Node.js 20+
- pnpm 9+

## Setup

1. Copy `.env.example` to `.env`
2. Set `MASTER_KEY` (32-byte hex or base64)
3. Install deps:
   - `pnpm install`
4. Start all services:
   - `pnpm dev`
5. Open web UI:
   - `http://localhost:5173`

## Seed accounts

All users are assigned to `team-default`.

- `builder / builder123` (`BUILDER`)
- `operator / operator123` (`OPERATOR`)
- `approver / approver123` (`APPROVER`)
- `auditor / auditor123` (`AUDITOR`)

## Environment variables

See `.env.example`:

- `MASTER_KEY` (required)
- `JWT_SECRET`
- `DB_PATH`
- `API_PORT`, `WEB_PORT`, `MCP_REGISTRY_PORT`, `MCP_STORE_PORT`, `MCP_AUDIT_PORT`
- `OPENAI_API_KEY` (optional)
- `ANTHROPIC_API_KEY` (optional)
- `GEMINI_API_KEY` (optional)

## MCP tools implemented

Registry MCP:
- `list_workflows`
- `get_workflow_version`
- `save_workflow_version`
- `list_agents`

Store MCP:
- `get_run`
- `upsert_run_state`
- `write_output`
- `list_runs`

Audit MCP:
- `append_record`
- `query_records`

## Governance rules enforced

By `Policy/Governance Agent` and orchestration pipeline:

- `confidence < 0.6` => approval required
- if output includes `costImpactUSD > 500` => approval required
- redact blocked fields: `ssn`, `phone`, `email`
- MCP tool allowlist per agent enforced; violations hard-fail and audit

## Provider settings behavior

- Keys are encrypted server-side using AES-256-GCM (`MASTER_KEY`)
- Frontend receives masked previews only
- No raw provider keys are returned to client
- If key is missing, agents run in mock mode

## Workflow usage flow

1. Login as `builder` to create/edit workflow versions
2. Login as `operator` to run workflows
3. Run pauses on approval node or policy-triggered approval
4. Login as `approver` to approve/reject
5. Login as `auditor` to inspect/export audit records

## Notes

- Optimization Agent creates PR-style proposals only (`optimization_proposals`); never auto-applies.
- MCP servers are used for workflow/run/audit persistence by design.