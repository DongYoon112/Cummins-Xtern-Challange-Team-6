import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { Provider } from "@agentfoundry/shared";

export type LlmEnvelope = {
  confidence: number;
  rationale: string;
  summary: string;
};

export type StrictJsonResult = {
  value: Record<string, unknown>;
  warnings: string[];
  mockMode: boolean;
  usedFallback: boolean;
};

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT =
  "Return strict JSON only with keys: confidence (0..1 number), rationale (string), summary (string).";

function parseEnvelope(raw: string): LlmEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LlmEnvelope>;
    if (
      typeof parsed.confidence === "number" &&
      typeof parsed.rationale === "string" &&
      typeof parsed.summary === "string"
    ) {
      return {
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        rationale: parsed.rationale,
        summary: parsed.summary
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function askProviderForObject(params: {
  provider: Provider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
}): Promise<Record<string, unknown> | null> {
  const { provider, model, apiKey, systemPrompt, prompt, maxTokens } = params;

  try {
    if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      });

      const text = completion.choices[0]?.message?.content;
      return text ? parseJsonObject(text) : null;
    }

    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens ?? 1200,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }]
      });

      const block = response.content.find((entry) => entry.type === "text");
      return block?.type === "text" ? parseJsonObject(block.text) : null;
    }

    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: `${systemPrompt}\n${prompt}`,
      config: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    });

    return response.text ? parseJsonObject(response.text) : null;
  } catch {
    return null;
  }
}

export async function askProviderForJson(params: {
  provider: Provider;
  model: string;
  apiKey: string;
  prompt: string;
}): Promise<LlmEnvelope | null> {
  const { provider, model, apiKey, prompt } = params;

  try {
    if (provider === "openai") {
      const client = new OpenAI({ apiKey });
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      });

      const text = completion.choices[0]?.message?.content;
      return text ? parseEnvelope(text) : null;
    }

    if (provider === "anthropic") {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: 200,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }]
      });

      const block = response.content.find((entry) => entry.type === "text");
      return block?.type === "text" ? parseEnvelope(block.text) : null;
    }

    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: `${SYSTEM_PROMPT}\n${prompt}`,
      config: {
        temperature: 0,
        responseMimeType: "application/json"
      }
    });

    return response.text ? parseEnvelope(response.text) : null;
  } catch {
    return null;
  }
}

export async function askProviderForStrictJson(params: {
  provider: Provider;
  model: string;
  apiKey?: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchemaHint?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  fallback: Record<string, unknown>;
}): Promise<StrictJsonResult> {
  const {
    provider,
    model,
    apiKey,
    systemPrompt,
    userPrompt,
    jsonSchemaHint,
    maxTokens,
    temperature,
    retries = 2,
    fallback
  } = params;

  const warnings: string[] = [];
  if (!apiKey) {
    warnings.push(`No API key configured for ${provider}; deterministic fallback used.`);
    return {
      value: fallback,
      warnings,
      mockMode: true,
      usedFallback: true
    };
  }

  if (apiKey.startsWith("mock://strict-success")) {
    const stanceMatch = userPrompt.match(/Required stance:\s([A-Z]+)/);
    const stance = stanceMatch?.[1] ?? "CONDITIONAL";
    const roleMatch = userPrompt.match(/Participant:\s(.+?)\s\(/);
    const role = roleMatch?.[1] ?? "Mock Participant";
    if (userPrompt.includes("Participant summaries from final round")) {
      return {
        value: {
          decision: "CONDITIONAL",
          confidence: 0.84,
          rationale: "Mock arbiter synthesis from participant summaries.",
          conditions: ["Apply staged rollout controls."],
          nextActions: ["Approve with guardrails."]
        },
        warnings: [],
        mockMode: false,
        usedFallback: false
      };
    }
    return {
      value: {
        role,
        stance,
        argument: {
          summary: `${role} mock argument for ${stance}.`,
          key_points: ["Mock key point A", "Mock key point B"],
          risks: ["Mock risk"],
          mitigations: ["Mock mitigation"]
        },
        evidence: ["mock-evidence"],
        confidence: 0.79
      },
      warnings: [],
      mockMode: false,
      usedFallback: false
    };
  }

  const strictSystem = [systemPrompt, "Return strict JSON only. Do not include markdown."]
    .filter(Boolean)
    .join("\n\n");
  const strictPrompt = [jsonSchemaHint ? `JSON schema hint:\n${jsonSchemaHint}` : "", userPrompt]
    .filter(Boolean)
    .join("\n\n");

  const attempts = Math.max(1, retries + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (provider === "openai") {
        const client = new OpenAI({ apiKey });
        const completion = await client.chat.completions.create({
          model,
          temperature: temperature ?? 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: strictSystem },
            { role: "user", content: strictPrompt }
          ]
        });
        const text = completion.choices[0]?.message?.content;
        const parsed = text ? parseJsonObject(text) : null;
        if (parsed) {
          return { value: parsed, warnings, mockMode: false, usedFallback: false };
        }
      } else if (provider === "anthropic") {
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens ?? 1200,
          temperature: temperature ?? 0,
          system: strictSystem,
          messages: [{ role: "user", content: strictPrompt }]
        });
        const block = response.content.find((entry) => entry.type === "text");
        const parsed = block?.type === "text" ? parseJsonObject(block.text) : null;
        if (parsed) {
          return { value: parsed, warnings, mockMode: false, usedFallback: false };
        }
      } else {
        const client = new GoogleGenAI({ apiKey });
        const response = await client.models.generateContent({
          model,
          contents: `${strictSystem}\n\n${strictPrompt}`,
          config: {
            temperature: temperature ?? 0,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json"
          }
        });
        const parsed = response.text ? parseJsonObject(response.text) : null;
        if (parsed) {
          return { value: parsed, warnings, mockMode: false, usedFallback: false };
        }
      }

      warnings.push(`Strict JSON parse failed for ${provider}/${model} on attempt ${attempt}.`);
    } catch (error) {
      warnings.push(
        `Provider call failed for ${provider}/${model} on attempt ${attempt}: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  warnings.push(`Deterministic fallback used for ${provider}/${model} after ${attempts} attempt(s).`);
  return {
    value: fallback,
    warnings,
    mockMode: true,
    usedFallback: true
  };
}

export async function testProviderConnection(params: {
  provider: Provider;
  model: string;
  apiKey?: string;
}) {
  const { provider, model, apiKey } = params;
  if (!apiKey) {
    return {
      ok: true,
      mockMode: true,
      message: "No API key configured for this provider. Mock mode is active."
    };
  }

  const envelope = await askProviderForJson({
    provider,
    model,
    apiKey,
    prompt: "Respond that the connection test succeeded."
  });

  if (!envelope) {
    return {
      ok: false,
      mockMode: false,
      message: "Provider request failed or did not return valid JSON envelope."
    };
  }

  return {
    ok: true,
    mockMode: false,
    message: "Connection successful",
    sample: envelope
  };
}
