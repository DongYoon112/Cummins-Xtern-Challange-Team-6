import { decryptSecret, encryptSecret, maskSecret } from "@agentfoundry/crypto";
import type { Provider } from "@agentfoundry/shared";
import { DEFAULT_MODELS, ProviderSchema } from "@agentfoundry/shared";
import { db } from "./db";

type TeamSettingsRow = {
  team_id: string;
  default_provider: Provider;
  default_model: string;
  openai_key_enc: string | null;
  anthropic_key_enc: string | null;
  gemini_key_enc: string | null;
  updated_at: string;
};

export type ServerTeamSettings = {
  teamId: string;
  defaultProvider: Provider;
  defaultModel: string;
  keys: Record<Provider, string | undefined>;
};

function getRow(teamId: string): TeamSettingsRow {
  const row = db.prepare("SELECT * FROM team_settings WHERE team_id = ? LIMIT 1").get(teamId) as
    | TeamSettingsRow
    | undefined;

  if (row) {
    return row;
  }

  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO team_settings (team_id, default_provider, default_model, updated_at) VALUES (?, ?, ?, ?)"
  ).run(teamId, "openai", DEFAULT_MODELS.openai, now);

  return db.prepare("SELECT * FROM team_settings WHERE team_id = ? LIMIT 1").get(teamId) as TeamSettingsRow;
}

function safeDecrypt(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return decryptSecret(value);
  } catch {
    return undefined;
  }
}

export function getTeamSettingsForServer(teamId: string): ServerTeamSettings {
  const row = getRow(teamId);

  const openai = safeDecrypt(row.openai_key_enc) ?? process.env.OPENAI_API_KEY;
  const anthropic = safeDecrypt(row.anthropic_key_enc) ?? process.env.ANTHROPIC_API_KEY;
  const gemini = safeDecrypt(row.gemini_key_enc) ?? process.env.GEMINI_API_KEY;

  return {
    teamId,
    defaultProvider: ProviderSchema.parse(row.default_provider),
    defaultModel: row.default_model,
    keys: {
      openai,
      anthropic,
      gemini
    }
  };
}

export function getTeamSettingsForClient(teamId: string) {
  const row = getRow(teamId);

  const openai = safeDecrypt(row.openai_key_enc);
  const anthropic = safeDecrypt(row.anthropic_key_enc);
  const gemini = safeDecrypt(row.gemini_key_enc);

  return {
    teamId,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    keyPreviews: {
      openai: openai ? maskSecret(openai) : "",
      anthropic: anthropic ? maskSecret(anthropic) : "",
      gemini: gemini ? maskSecret(gemini) : ""
    },
    hasKeys: {
      openai: Boolean(openai || process.env.OPENAI_API_KEY),
      anthropic: Boolean(anthropic || process.env.ANTHROPIC_API_KEY),
      gemini: Boolean(gemini || process.env.GEMINI_API_KEY)
    },
    updatedAt: row.updated_at
  };
}

export function saveProviderKey(teamId: string, provider: Provider, rawKey: string) {
  const column =
    provider === "openai"
      ? "openai_key_enc"
      : provider === "anthropic"
        ? "anthropic_key_enc"
        : "gemini_key_enc";

  const now = new Date().toISOString();
  const encrypted = encryptSecret(rawKey);

  db.prepare(
    `
    UPDATE team_settings
    SET ${column} = ?, updated_at = ?
    WHERE team_id = ?
    `
  ).run(encrypted, now, teamId);
}

export function updateProviderDefaults(teamId: string, provider: Provider, model: string) {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE team_settings SET default_provider = ?, default_model = ?, updated_at = ? WHERE team_id = ?"
  ).run(provider, model, now, teamId);
}