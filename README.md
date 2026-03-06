# Orange Lantern MVP

Orange Lantern is a monorepo starter for governed multi-agent workflow execution in supply chain/manufacturing domains.

## Repo summary

Orange Lantern is a full-stack workflow platform where teams can design AI-assisted workflows, publish versioned definitions, run them with approvals, and audit every decision. It combines:

- A Home dashboard for high-level stats (estimated API credits, responses, operations, run health)
- A Builder UI for creating draft workflow graphs (`Start`, `LLM`, `Tool`, `Router`, `Memory`, `Output`)
- A publish pipeline that compiles drafts into runnable workflow versions
- A run engine that executes steps, pauses for approvals, and resumes after decisions
- Governance controls (RBAC, tool allowlists, policy gates, audit logs)
- Provider + tool configuration for practical local deployment (OpenAI/Anthropic/Gemini, optional external DB queries)
- A sidebar notification center with actionable alerts routed to the relevant page (`/approvals`, `/run?runId=...`)

In short: this repo is a governed "builder -> publish -> run -> approve -> audit" system for enterprise-style agent workflows.

## Example company scenario

### Acme Components (manufacturing supplier)

Acme receives a high-priority order and needs to decide whether to ship now, backorder, or use expedited logistics.

1. A `BUILDER` creates a workflow:
   - `Start -> Inventory Check -> Logistics Plan -> Finance Impact -> Approval -> Notify Team -> Output`
2. They publish version `v3` of the workflow.
3. An `OPERATOR` runs `v3` for order `ORD-1001`.
4. The workflow detects a shortage and proposes an expedited shipment with higher cost.
5. Policy flags `costImpactUSD > 500`, so the run pauses and creates an approval.
6. An `APPROVER` reviews the context and approves the decision.
7. The run resumes, sends the notification, and completes.
8. An `AUDITOR` exports the audit log to verify:
   - who ran it
   - which version executed
   - why approval was required
   - which actions were taken

Result: Acme gets faster, more consistent operational decisions with human oversight and a traceable compliance trail.

## What is included

- React web app with sidebar pages: `Home`, `Workflows`, `Operations`, `Run`, `Approvals`, `Audit Log`, `Settings`, `Docs`
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
- No automatic workflow template seeding; repositories come from real backend writes.
- No automatic synthetic inventory/supplier/order/rate seeding.

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

## Bootstrap account

On a fresh database, the API creates one admin user from environment variables:

- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `DEFAULT_TEAM_ID` (defaults to `team-main`)
- `DEFAULT_TEAM_NAME` (defaults to `Primary Team`)

## Environment variables

See `.env.example`:

- `MASTER_KEY` (required)
- `JWT_SECRET`
- `DB_PATH`
- `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`
- `DEFAULT_TEAM_ID`, `DEFAULT_TEAM_NAME`
- `API_PORT`, `WEB_PORT`, `MCP_REGISTRY_PORT`, `MCP_STORE_PORT`, `MCP_AUDIT_PORT`
- `OPENAI_API_KEY` (optional)
- `ANTHROPIC_API_KEY` (optional)
- `GEMINI_API_KEY` (optional)
- `DATABASE_URL` (optional but preferred for CMAPSS DB write step)
- `CMAPSS_CACHE_DIR` (optional, default `./data/CMAPSS`)
- `CMAPSS_DOWNLOAD_URL` (optional, default NASA legacy zip URL)
- `CMAPSS_SQLITE_PATH` (optional sqlite fallback path for CMAPSS incident writes)

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

1. Login and land on `Home` for platform-level metrics and recent activity.
2. Use `Workflows` to create/edit workflow versions and publish.
3. Use `Run` or `Operations` to start and monitor workflow runs.
4. Run pauses on approval node or policy-triggered approval.
5. `APPROVER`/`ADMIN` can open `Approvals` to approve/reject.
6. Use `Audit Log` to inspect/export governance records.
7. Open `Docs` for quick-start usage guidance.

## CMAPSS demo workflow

Starter graph is prefilled in new drafts:

`Start -> Dataset Loader -> Feature Builder -> Debate -> Orchestrator -> DB Write -> Output`

Defaults:
- `dataset=dataset` (free-text key, not hardcoded)
- `unit_id=1`
- `window=50`
- loader `source=download` (auto-download + cache under `CMAPSS_CACHE_DIR`)
- optional `dataset_url` for direct text/zip link override (if blank, uses `CMAPSS_DOWNLOAD_URL`)
- DB write target defaults to sqlite (`CMAPSS_SQLITE_PATH`) unless `db_target=postgres` and `DATABASE_URL` is set.

Dataset loader behavior:
- No dataset options are hardcoded in UI.
- Enter any dataset key you want (for naming/tracking).
- With `source=download`, the loader can pull from a direct `.txt` URL or a `.zip` URL.
- With `source=local`, place dataset text files in cache dir (for example: `train_<DATASET_KEY>.txt`).

Run:
1. `pnpm dev`
2. Create/publish the default CMAPSS draft in `Workflows`.
3. Start a run.
4. In `Run` page, verify step outputs:
   - `Debate`: JSON with `primary_issue`, `confidence`, `hypotheses`, `recommended_actions`
   - `Orchestrator`: `incident` object
   - `DB Write`: `insert_id` and `status=inserted`

All step outputs are persisted via existing `mcp-store` `write_output`.

## Sidebar UX additions

- Hover any sidebar option to see a summary popup.
- If current role cannot access an option, popup explains allowed roles.
- `Alerts` button opens notification center in the sidebar.
- Clicking an alert routes directly to what needs action:
  - Approval alerts -> `Approvals`
  - Run alerts -> `Run` with `runId` query preselected

## Builder Step 1 (Agent Type + Core Tools)

1. Open `Workflows` and choose mode: `Flowchart` or `Developer`.
2. Configure:
   - Agent Type (`Orchestrator`, `Research`, `Code`, `Data/Analytics`, `Ops/DevOps`, `Custom`)
   - Core tools (multi-select) and tool-specific settings (API key/base URL/scopes/rate limits)
3. Flowchart mode supports:
   - Node canvas with pan/zoom + grid
   - Node types: `Start`, `LLM`, `Tool`, `Router`, `Memory`, `Debate`, `Dataset Loader`, `Feature Builder`, `DB Write`, `Output`
   - Edge creation via node handles
   - Right-side node config drawer
4. Developer mode supports:
   - Step-list wizard (`Model`, `Tools`, `Memory`, `Routing`, `Output`, `Review`)
   - Forms that edit the same underlying JSON schema as Flowchart mode
5. Use `Save Draft`:
   - Saves to browser `localStorage`
   - POSTs to `POST /workflows/draft`
6. Validation enforced before save:
   - Exactly one `Start`
   - At least one `Output`
   - Connected path from `Start` to an `Output`

Settings tab key storage:
- `Server Encrypted` (recommended): API-side encrypted using `MASTER_KEY`
- `Local Dev`: browser `localStorage` for quick local iteration

## Notes

- Optimization Agent creates PR-style proposals only (`optimization_proposals`); never auto-applies.
- MCP servers are used for workflow/run/audit persistence by design.
