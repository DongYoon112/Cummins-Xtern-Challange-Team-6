import { askProviderForJson } from "../lib/providers";
import type { ServerTeamSettings } from "../lib/settings";
import { db } from "../lib/db";
import { executeExternalQuery, executeReadOnlyExternalQuery } from "../lib/externalDb";
import { DEFAULT_MODELS, type Provider } from "@agentfoundry/shared";

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

function isProvider(value: unknown): value is Provider {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

function renderPromptTemplate(template: string, runContext: Record<string, unknown>) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const raw = runContext[key];
    if (raw === null || raw === undefined) {
      return "";
    }
    if (typeof raw === "object") {
      try {
        return JSON.stringify(raw);
      } catch {
        return "";
      }
    }
    return String(raw);
  });
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

  if (agentName === "LLM Agent") {
    const databaseMode =
      stepParams.toolId === "database" ||
      stepParams.toolHint === "database" ||
      stepParams.mode === "external_db_query" ||
      stepParams.mode === "external_db_write" ||
      typeof stepParams.query === "string";
    const llmQuery = typeof stepParams.query === "string" ? stepParams.query : "";
    const llmAllowDbWrite = stepParams.allowDbWrite === true || stepParams.mode === "external_db_write";
    let dbOutput: Record<string, unknown> | undefined;
    if (databaseMode && llmQuery.trim()) {
      const connectionString =
        String(
          stepParams.connectionString ??
            runContext.databaseConnectionString ??
            teamSettings.externalDbUrl ??
            process.env.EXTERNAL_DB_URL ??
            ""
        );
      if (!connectionString) {
        return {
          output: {
            error: "Database connection string missing.",
            hint: "Set LLM node connectionString, settings external DB URL, or EXTERNAL_DB_URL."
          },
          confidence: 0.2,
          rationale: "LLM Agent requested DB access but no connection string is configured.",
          toolCalls,
          mockMode: true
        };
      }
      const queryParams = Array.isArray(stepParams.queryParams) ? stepParams.queryParams : [];
      const maxRows = typeof stepParams.maxRows === "number" ? stepParams.maxRows : 100;
      const query = renderPromptTemplate(llmQuery, runContext);
      const result = llmAllowDbWrite
        ? await executeExternalQuery({
            connectionString,
            query,
            params: queryParams,
            maxRows,
            allowWrite: true
          })
        : await executeReadOnlyExternalQuery({
            connectionString,
            query,
            params: queryParams,
            maxRows
          });
      dbOutput = {
        engine: result.engine,
        rowCount: result.rowCount,
        rows: result.rows,
        writeEnabled: llmAllowDbWrite
      };
      toolCalls.push({
        server: "external-db",
        tool: llmAllowDbWrite ? "execute_query" : "read_only_query",
        args: {
          engine: result.engine,
          maxRows,
          query: query.slice(0, 300),
          writeEnabled: llmAllowDbWrite
        }
      });
    }

    const requestedProvider = stepParams.llmProvider;
    const provider = isProvider(requestedProvider) ? requestedProvider : teamSettings.defaultProvider;
    const model =
      typeof stepParams.llmModel === "string" && stepParams.llmModel.trim()
        ? stepParams.llmModel.trim()
        : provider === teamSettings.defaultProvider
          ? teamSettings.defaultModel
          : DEFAULT_MODELS[provider];
    const apiKey = teamSettings.keys[provider];

    const rawPrompt =
      typeof stepParams.prompt === "string" && stepParams.prompt.trim()
        ? stepParams.prompt
        : typeof stepParams.question === "string" && stepParams.question.trim()
          ? stepParams.question
          : "Summarize the run context and provide the most important next action.";
    const prompt = renderPromptTemplate(rawPrompt, runContext);
    const systemPrompt =
      typeof stepParams.systemPrompt === "string" && stepParams.systemPrompt.trim()
        ? stepParams.systemPrompt.trim()
        : "You are a precise operations assistant. Keep responses concise.";

    if (!apiKey) {
      return {
        output: {
          provider,
          model,
          prompt,
          answer: `Mock response: ${prompt}`,
          mockMode: true
        },
        confidence: 0.45,
        rationale: `No ${provider} API key configured. Returned mock LLM output.`,
        toolCalls,
        mockMode: true
      };
    }

    const envelope = await askProviderForJson({
      provider,
      model,
      apiKey,
      prompt: `${systemPrompt}\n\nUser prompt:\n${prompt}\n\nContext:\n${JSON.stringify(runContext).slice(0, 2000)}${
        dbOutput ? `\n\nDatabase result:\n${JSON.stringify(dbOutput).slice(0, 2000)}` : ""
      }`
    });

    toolCalls.push({
      server: provider,
      tool: "chat.completions",
      args: {
        model
      }
    });

    if (!envelope) {
      return {
        output: {
          provider,
          model,
          prompt,
          database: dbOutput ?? null,
          answer: "Provider call failed. No response envelope returned.",
          mockMode: false
        },
        confidence: 0.3,
        rationale: "Provider call failed for LLM Agent step.",
        toolCalls,
        mockMode: false
      };
    }

    return {
      output: {
        provider,
        model,
        prompt,
        database: dbOutput ?? null,
        answer: envelope.summary,
        mockMode: false
      },
      confidence: clamp(envelope.confidence),
      rationale: envelope.rationale,
      toolCalls,
      mockMode: false
    };
  }

  const databaseMode =
    stepParams.toolId === "database" ||
    stepParams.toolHint === "database" ||
    stepParams.mode === "external_db_query";
  if (databaseMode && typeof stepParams.query === "string") {
    const connectionString =
      String(
        stepParams.connectionString ??
          runContext.databaseConnectionString ??
          teamSettings.externalDbUrl ??
          process.env.EXTERNAL_DB_URL ??
          ""
      );
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

  if (agentName === "Debate Agent") {
    const rawParticipants = Array.isArray(stepParams.participants) ? stepParams.participants : [];
    const participants = rawParticipants
      .map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {}))
      .map((entry) => {
        const provider = String(entry.provider ?? "").toLowerCase();
        if (provider !== "openai" && provider !== "anthropic" && provider !== "gemini") {
          return null;
        }
        const p = provider as Provider;
        const model = String(entry.model ?? DEFAULT_MODELS[p]);
        const stance = typeof entry.stance === "string" ? entry.stance : "";
        return { provider: p, model, stance };
      })
      .filter((item): item is { provider: Provider; model: string; stance: string } => Boolean(item));

    const debateParticipants =
      participants.length > 0
        ? participants
        : (["openai", "anthropic", "gemini"] as Provider[]).map((provider) => ({
            provider,
            model: teamSettings.defaultProvider === provider ? teamSettings.defaultModel : DEFAULT_MODELS[provider],
            stance: ""
          }));

    const topic = String(
      stepParams.debateTopic ??
        stepParams.prompt ??
        runContext.lastSummary ??
        runContext.orderId ??
        "Evaluate options and produce a final recommendation."
    );
    const rounds = Math.max(1, Number(stepParams.debateRounds ?? 1) || 1);

    const argumentsByModel: Array<{
      provider: Provider;
      model: string;
      stance?: string;
      summary: string;
      rationale: string;
      confidence: number;
      mockMode: boolean;
    }> = [];

    for (let round = 1; round <= rounds; round += 1) {
      for (const participant of debateParticipants) {
        const key = teamSettings.keys[participant.provider];
        const participantLabel = `${participant.provider}/${participant.model}`;
        if (!key) {
          argumentsByModel.push({
            provider: participant.provider,
            model: participant.model,
            stance: participant.stance || undefined,
            summary: `(${participantLabel}) mock stance: ${participant.stance || "balanced"} on "${topic}"`,
            rationale: "No provider key configured. Used deterministic mock argument.",
            confidence: 0.55,
            mockMode: true
          });
          continue;
        }

        const priorArguments =
          argumentsByModel.length === 0
            ? "No prior arguments."
            : argumentsByModel
                .slice(-Math.max(0, debateParticipants.length))
                .map((arg) => `${arg.provider}/${arg.model}: ${arg.summary}`)
                .join("\n");

        const envelope = await askProviderForJson({
          provider: participant.provider,
          model: participant.model,
          apiKey: key,
          prompt: [
            `Debate topic: ${topic}`,
            `Round: ${round}`,
            participant.stance ? `Preferred stance: ${participant.stance}` : "Preferred stance: balanced",
            `Run context: ${JSON.stringify(runContext).slice(0, 1500)}`,
            `Previous arguments:\n${priorArguments}`,
            "Provide your concise argument."
          ].join("\n")
        });

        if (!envelope) {
          argumentsByModel.push({
            provider: participant.provider,
            model: participant.model,
            stance: participant.stance || undefined,
            summary: `(${participantLabel}) failed to generate argument; fallback argument applied.`,
            rationale: "Provider call failed.",
            confidence: 0.5,
            mockMode: false
          });
          continue;
        }

        argumentsByModel.push({
          provider: participant.provider,
          model: participant.model,
          stance: participant.stance || undefined,
          summary: envelope.summary,
          rationale: envelope.rationale,
          confidence: envelope.confidence,
          mockMode: false
        });
      }
    }

    const best = argumentsByModel.reduce(
      (current, candidate) => (candidate.confidence > current.confidence ? candidate : current),
      argumentsByModel[0]
    );

    const arbiterProvider = teamSettings.defaultProvider;
    const arbiterModel = teamSettings.defaultModel;
    const arbiterKey = teamSettings.keys[arbiterProvider];

    let finalRecommendation = best?.summary ?? "No recommendation.";
    let finalRationale = best?.rationale ?? "No arguments generated.";
    let finalConfidence = best?.confidence ?? 0.5;
    let synthesisMode: "llm" | "fallback" = "fallback";

    if (arbiterKey && argumentsByModel.length > 0) {
      const synthesis = await askProviderForJson({
        provider: arbiterProvider,
        model: arbiterModel,
        apiKey: arbiterKey,
        prompt: [
          `You are the final arbiter for a multi-model debate.`,
          `Topic: ${topic}`,
          `Arguments:`,
          ...argumentsByModel.map(
            (arg, index) =>
              `${index + 1}. ${arg.provider}/${arg.model} [conf ${arg.confidence.toFixed(2)}]: ${arg.summary}`
          ),
          "Return final recommendation and rationale."
        ].join("\n")
      });

      if (synthesis) {
        finalRecommendation = synthesis.summary;
        finalRationale = synthesis.rationale;
        finalConfidence = Math.max(finalConfidence, synthesis.confidence);
        synthesisMode = "llm";
      }
    }

    toolCalls.push({
      server: "multi-model",
      tool: "debate",
      args: {
        rounds,
        participants: debateParticipants.map((item) => `${item.provider}/${item.model}`)
      }
    });

    return {
      output: {
        topic,
        rounds,
        participants: debateParticipants,
        arguments: argumentsByModel,
        finalRecommendation,
        synthesisMode
      },
      confidence: clamp(finalConfidence),
      rationale: finalRationale,
      toolCalls,
      mockMode: argumentsByModel.every((item) => item.mockMode)
    };
  }

  if (agentName === "Notification Agent") {
    const mode = String(stepParams.outputMode ?? "run_summary");
    const summary = String(runContext.lastSummary ?? "Workflow completed");
    const destination = String(runContext.destination ?? "Operations Team");
    const messageTemplate =
      typeof stepParams.messageTemplate === "string" && stepParams.messageTemplate.trim()
        ? stepParams.messageTemplate
        : `# Run Summary\n\n- Destination: ${destination}\n- Summary: ${summary}`;
    const includeContext = stepParams.includeContext === true;
    const contextPayload = includeContext ? runContext : undefined;

    if (mode === "webhook") {
      const webhookUrl = String(stepParams.webhookUrl ?? "").trim();
      if (!webhookUrl) {
        return {
          output: {
            outputMode: "webhook",
            error: "Missing webhookUrl."
          },
          confidence: 0.2,
          rationale: "Webhook output mode selected but webhook URL is missing.",
          toolCalls,
          mockMode: true
        };
      }

      const payload = {
        message: messageTemplate,
        summary,
        destination,
        context: contextPayload ?? null
      };

      let statusCode = 0;
      let responseText = "";
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        statusCode = response.status;
        responseText = await response.text();
      } catch (error) {
        return {
          output: {
            outputMode: "webhook",
            webhookUrl,
            sent: false,
            error: error instanceof Error ? error.message : "Webhook request failed."
          },
          confidence: 0.25,
          rationale: "Webhook request failed.",
          toolCalls: [
            ...toolCalls,
            {
              server: "webhook",
              tool: "post",
              args: { webhookUrl }
            }
          ],
          mockMode: false
        };
      }

      return {
        output: {
          outputMode: "webhook",
          webhookUrl,
          sent: statusCode >= 200 && statusCode < 300,
          statusCode,
          responseText: responseText.slice(0, 2000)
        },
        confidence: statusCode >= 200 && statusCode < 300 ? 0.92 : 0.45,
        rationale: `Webhook POST completed with status ${statusCode}.`,
        toolCalls: [
          ...toolCalls,
          {
            server: "webhook",
            tool: "post",
            args: { webhookUrl, statusCode }
          }
        ],
        mockMode: false
      };
    }

    const draftOutput = {
      outputMode: "run_summary",
      artifactType: "markdown",
      markdown: messageTemplate,
      summary,
      recipientGroup: destination,
      context: contextPayload ?? null
    };

    const baseConfidence = 0.93;
    const baseRationale = "Run summary artifact generated from run context.";

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
