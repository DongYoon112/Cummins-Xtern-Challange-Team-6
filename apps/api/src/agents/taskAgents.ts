import { askProviderForJson } from "../lib/providers";
import type { ServerTeamSettings } from "../lib/settings";
import { db } from "../lib/db";
import { executeReadOnlyExternalQuery } from "../lib/externalDb";

type TaskResult = {
  output: Record<string, unknown>;
  confidence: number;
  rationale: string;
  toolCalls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
  mockMode: boolean;
};

function destinationToRegion(destination: string): string {
  const normalized = destination.toLowerCase();
  if (normalized.includes("indianapolis") || normalized.includes("chicago")) {
    return "US-MW";
  }
  if (normalized.includes("nashville") || normalized.includes("atlanta")) {
    return "US-SE";
  }
  return "APAC";
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

async function maybeRefineWithLlm(
  teamSettings: ServerTeamSettings,
  agentName: string,
  draftOutput: Record<string, unknown>,
  draftConfidence: number,
  draftRationale: string
): Promise<{ confidence: number; rationale: string; mockMode: boolean }> {
  const provider = teamSettings.defaultProvider;
  const model = teamSettings.defaultModel;
  const key = teamSettings.keys[provider];

  if (!key) {
    return {
      confidence: draftConfidence,
      rationale: `${draftRationale} (mock mode: no provider key configured)`,
      mockMode: true
    };
  }

  const envelope = await askProviderForJson({
    provider,
    model,
    apiKey: key,
    prompt: `Agent: ${agentName}\nDraft output: ${JSON.stringify(
      draftOutput
    )}\nDraft rationale: ${draftRationale}\nRefine confidence and rationale.`
  });

  if (!envelope) {
    return {
      confidence: draftConfidence,
      rationale: `${draftRationale} (provider fallback to deterministic rationale)`,
      mockMode: false
    };
  }

  return {
    confidence: clamp((draftConfidence + envelope.confidence) / 2),
    rationale: envelope.rationale,
    mockMode: false
  };
}

export async function runTaskAgent(params: {
  agentName: string;
  stepParams: Record<string, unknown>;
  runContext: Record<string, unknown>;
  teamSettings: ServerTeamSettings;
}): Promise<TaskResult> {
  const { agentName, stepParams, runContext, teamSettings } = params;
  const toolCalls: TaskResult["toolCalls"] = [];

  const databaseMode =
    stepParams.toolId === "database" ||
    stepParams.toolHint === "database" ||
    stepParams.mode === "external_db_query";
  if (databaseMode && typeof stepParams.query === "string") {
    const connectionString =
      String(stepParams.connectionString ?? runContext.databaseConnectionString ?? process.env.EXTERNAL_DB_URL ?? "");
    if (!connectionString) {
      return {
        output: {
          error: "Database connection string missing.",
          hint: "Set Database tool connectionString or EXTERNAL_DB_URL."
        },
        confidence: 0.2,
        rationale: "External DB query requested but no connection string provided.",
        toolCalls,
        mockMode: true
      };
    }

    const query = String(stepParams.query);
    const queryParams = Array.isArray(stepParams.queryParams) ? stepParams.queryParams : [];
    const maxRows = typeof stepParams.maxRows === "number" ? stepParams.maxRows : 100;

    const result = await executeReadOnlyExternalQuery({
      connectionString,
      query,
      params: queryParams,
      maxRows
    });

    toolCalls.push({
      server: "external-db",
      tool: "read_only_query",
      args: {
        engine: result.engine,
        query: query.slice(0, 300),
        maxRows
      }
    });

    return {
      output: {
        engine: result.engine,
        rowCount: result.rowCount,
        rows: result.rows
      },
      confidence: 0.91,
      rationale: `Executed read-only ${result.engine} query and returned ${result.rowCount} rows.`,
      toolCalls,
      mockMode: false
    };
  }

  if (agentName === "Inventory Agent") {
    const orderId = String(stepParams.orderId ?? runContext.orderId ?? "ORD-1001");
    const order = db.prepare("SELECT * FROM orders WHERE order_id = ? LIMIT 1").get(orderId) as
      | {
          order_id: string;
          sku: string;
          qty: number;
          destination: string;
          requested_date: string;
        }
      | undefined;

    const sku = String(stepParams.sku ?? order?.sku ?? "SKU-100");
    const inventory = db.prepare("SELECT * FROM inventory WHERE sku = ? LIMIT 1").get(sku) as
      | {
          sku: string;
          on_hand: number;
          reserved: number;
          reorder_days: number;
        }
      | undefined;

    toolCalls.push({
      server: "internal-db",
      tool: "select_order",
      args: { orderId }
    });
    toolCalls.push({
      server: "internal-db",
      tool: "select_inventory",
      args: { sku }
    });

    const available = Math.max(0, (inventory?.on_hand ?? 0) - (inventory?.reserved ?? 0));
    const qty = order?.qty ?? toNumber(stepParams.qty, 10);
    const shortage = Math.max(0, qty - available);

    const draftOutput = {
      orderId,
      sku,
      requestedQty: qty,
      availableQty: available,
      shortageQty: shortage,
      recommendedAction:
        shortage > 0 ? `Backorder ${shortage} units and expedite replenishment` : "Fulfill from stock"
    };

    const baseConfidence = shortage > 0 ? 0.74 : 0.9;
    const baseRationale =
      shortage > 0
        ? "Available stock does not meet requested quantity. Backorder path recommended."
        : "On-hand stock can satisfy order immediately.";

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Supplier Risk Agent") {
    const supplierId = String(stepParams.supplierId ?? runContext.supplierId ?? "SUP-02");
    const supplier = db
      .prepare("SELECT * FROM suppliers WHERE supplier_id = ? LIMIT 1")
      .get(supplierId) as
      | {
          supplier_id: string;
          name: string;
          risk_score: number;
          on_time_pct: number;
          region: string;
        }
      | undefined;

    toolCalls.push({
      server: "internal-db",
      tool: "select_supplier",
      args: { supplierId }
    });

    const riskScore = supplier?.risk_score ?? 0.5;
    const riskBand = riskScore >= 0.7 ? "HIGH" : riskScore >= 0.4 ? "MEDIUM" : "LOW";
    const costImpactUSD = Math.round(riskScore * 900);

    const draftOutput = {
      supplierId,
      supplierName: supplier?.name ?? "Unknown",
      region: supplier?.region ?? "UNKNOWN",
      riskScore,
      onTimePct: supplier?.on_time_pct ?? 0,
      riskBand,
      mitigation: riskBand === "HIGH" ? "Require secondary source before PO release" : "Proceed",
      costImpactUSD
    };

    const baseConfidence = 0.82 - riskScore * 0.15;
    const baseRationale = `Supplier risk score ${riskScore.toFixed(
      2
    )} produced ${riskBand} classification.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Logistics Agent") {
    const destination = String(stepParams.destination ?? runContext.destination ?? "Indianapolis");
    const region = destinationToRegion(destination);
    const rates = db
      .prepare("SELECT * FROM shipping_rates WHERE region = ? ORDER BY rate_usd ASC")
      .all(region) as Array<{ carrier: string; mode: string; region: string; rate_usd: number; lead_days: number }>;

    toolCalls.push({
      server: "internal-db",
      tool: "select_shipping_rates",
      args: { region }
    });

    const choice = rates[0] ?? {
      carrier: "Fallback",
      mode: "ground",
      region,
      rate_usd: 300,
      lead_days: 5
    };

    const expedite = rates.find((rate) => rate.mode === "air") ?? choice;

    const draftOutput = {
      destination,
      region,
      selectedCarrier: choice.carrier,
      mode: choice.mode,
      etaDays: choice.lead_days,
      shippingCostUSD: choice.rate_usd,
      expeditedOption: {
        carrier: expedite.carrier,
        mode: expedite.mode,
        etaDays: expedite.lead_days,
        shippingCostUSD: expedite.rate_usd
      },
      costImpactUSD: choice.rate_usd
    };

    const baseConfidence = choice.mode === "ground" ? 0.86 : 0.78;
    const baseRationale = `Selected lowest-cost option ${choice.carrier}/${choice.mode} for ${region}.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Finance Agent") {
    const logisticsCost = toNumber(runContext.lastLogisticsCostUSD, 200);
    const shortageQty = toNumber(runContext.lastShortageQty, 0);
    const unitPrice = toNumber(runContext.unitPrice, 100);
    const penalty = shortageQty * unitPrice * 0.05;
    const costImpactUSD = Math.round(logisticsCost + penalty);

    const draftOutput = {
      logisticsCostUSD: logisticsCost,
      shortagePenaltyUSD: Math.round(penalty),
      costImpactUSD,
      estimatedMarginImpactPct: Number((costImpactUSD / 5000).toFixed(3)),
      recommendation:
        costImpactUSD > 500 ? "Route to approver due to financial impact" : "Proceed within delegated threshold"
    };

    const baseConfidence = costImpactUSD > 500 ? 0.62 : 0.83;
    const baseRationale = `Computed total cost impact from shipping + shortage penalty: ${costImpactUSD}.`;

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  if (agentName === "Notification Agent") {
    const summary = String(runContext.lastSummary ?? "Workflow completed");
    const destination = String(runContext.destination ?? "Operations Team");

    const draftOutput = {
      channel: String(stepParams.channel ?? "email"),
      recipientGroup: destination,
      message: `Action summary: ${summary}. Review run details in AgentFoundry.`
    };

    const baseConfidence = 0.93;
    const baseRationale = "Notification message template generated from run context.";

    const refined = await maybeRefineWithLlm(
      teamSettings,
      agentName,
      draftOutput,
      baseConfidence,
      baseRationale
    );

    return {
      output: draftOutput,
      confidence: refined.confidence,
      rationale: refined.rationale,
      toolCalls,
      mockMode: refined.mockMode
    };
  }

  const draftOutput = {
    message: `No implementation for ${agentName}`
  };

  return {
    output: draftOutput,
    confidence: 0.5,
    rationale: "Unknown task agent",
    toolCalls,
    mockMode: true
  };
}
