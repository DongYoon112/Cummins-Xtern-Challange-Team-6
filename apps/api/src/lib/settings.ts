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
  external_db_url_enc: string | null;
  updated_at: string;
};

type RepoSettingsRow = TeamSettingsRow & {
  repo_id: string;
};

export type ServerTeamSettings = {
  teamId: string;
  defaultProvider: Provider;
  defaultModel: string;
  keys: Record<Provider, string | undefined>;
  externalDbUrl?: string;
  repoId?: string;
};

function getTeamRow(teamId: string): TeamSettingsRow {
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

function getRepoRow(teamId: string, repoId: string): RepoSettingsRow {
  const row = db
    .prepare("SELECT * FROM repo_settings WHERE team_id = ? AND repo_id = ? LIMIT 1")
    .get(teamId, repoId) as RepoSettingsRow | undefined;

  if (row) {
    return row;
  }

  const team = getTeamRow(teamId);
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO repo_settings
      (team_id, repo_id, default_provider, default_model, openai_key_enc, anthropic_key_enc, gemini_key_enc, external_db_url_enc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    teamId,
    repoId,
    team.default_provider,
    team.default_model,
    team.openai_key_enc,
    team.anthropic_key_enc,
    team.gemini_key_enc,
    team.external_db_url_enc,
    now
  );

  return db
    .prepare("SELECT * FROM repo_settings WHERE team_id = ? AND repo_id = ? LIMIT 1")
    .get(teamId, repoId) as RepoSettingsRow;
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

function isValidProviderKey(provider: Provider, value?: string) {
  if (!value) {
    return false;
  }
  const key = value.trim();
  if (!key || key.toUpperCase().startsWith("MAST")) {
    return false;
  }
  if (provider === "openai") {
    return key.startsWith("sk-");
  }
  if (provider === "anthropic") {
    return key.startsWith("sk-ant-");
  }
  if (provider === "gemini") {
    return key.startsWith("AIza");
  }
  return false;
}

function resolveEffectiveKey(provider: Provider, repoValue: string | undefined, teamValue: string | undefined, envValue: string | undefined) {
  if (isValidProviderKey(provider, repoValue)) {
    return repoValue?.trim();
  }
  if (isValidProviderKey(provider, teamValue)) {
    return teamValue?.trim();
  }
  if (isValidProviderKey(provider, envValue)) {
    return envValue?.trim();
  }
  return undefined;
}

function effectiveRow(teamId: string, repoId?: string) {
  if (repoId && repoId.trim()) {
    return getRepoRow(teamId, repoId.trim());
  }
  return getTeamRow(teamId);
}

export function getTeamSettingsForServer(teamId: string, repoId?: string): ServerTeamSettings {
  const teamRow = getTeamRow(teamId);
  const repoRow = repoId && repoId.trim() ? getRepoRow(teamId, repoId.trim()) : null;
  const row = repoRow ?? teamRow;

  const openai = resolveEffectiveKey(
    "openai",
    safeDecrypt(repoRow?.openai_key_enc ?? null),
    safeDecrypt(teamRow.openai_key_enc),
    process.env.OPENAI_API_KEY
  );
  const anthropic = resolveEffectiveKey(
    "anthropic",
    safeDecrypt(repoRow?.anthropic_key_enc ?? null),
    safeDecrypt(teamRow.anthropic_key_enc),
    process.env.ANTHROPIC_API_KEY
  );
  const gemini = resolveEffectiveKey(
    "gemini",
    safeDecrypt(repoRow?.gemini_key_enc ?? null),
    safeDecrypt(teamRow.gemini_key_enc),
    process.env.GEMINI_API_KEY
  );
  const externalDbUrl =
    safeDecrypt(repoRow?.external_db_url_enc ?? null) ?? safeDecrypt(teamRow.external_db_url_enc) ?? process.env.EXTERNAL_DB_URL;

  return {
    teamId,
    defaultProvider: ProviderSchema.parse(row.default_provider),
    defaultModel: row.default_model,
    keys: {
      openai,
      anthropic,
      gemini
    },
    externalDbUrl,
    repoId: repoId?.trim() || undefined
  };
}

export function getTeamSettingsForClient(teamId: string, repoId?: string) {
  const teamRow = getTeamRow(teamId);
  const repoRow = repoId && repoId.trim() ? getRepoRow(teamId, repoId.trim()) : null;
  const row = repoRow ?? teamRow;

  const openai = safeDecrypt(repoRow?.openai_key_enc ?? null) ?? safeDecrypt(teamRow.openai_key_enc);
  const anthropic = safeDecrypt(repoRow?.anthropic_key_enc ?? null) ?? safeDecrypt(teamRow.anthropic_key_enc);
  const gemini = safeDecrypt(repoRow?.gemini_key_enc ?? null) ?? safeDecrypt(teamRow.gemini_key_enc);
  const externalDbUrl = safeDecrypt(repoRow?.external_db_url_enc ?? null) ?? safeDecrypt(teamRow.external_db_url_enc);

  return {
    teamId,
    repoId: repoId?.trim() || null,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    keyPreviews: {
      openai: openai ? maskSecret(openai) : "",
      anthropic: anthropic ? maskSecret(anthropic) : "",
      gemini: gemini ? maskSecret(gemini) : ""
    },
    externalDbUrlPreview: externalDbUrl ? maskSecret(externalDbUrl) : "",
    hasKeys: {
      openai: Boolean(openai || process.env.OPENAI_API_KEY),
      anthropic: Boolean(anthropic || process.env.ANTHROPIC_API_KEY),
      gemini: Boolean(gemini || process.env.GEMINI_API_KEY)
    },
    hasExternalDbUrl: Boolean(externalDbUrl || process.env.EXTERNAL_DB_URL),
    updatedAt: row.updated_at
  };
}

export function saveProviderKey(teamId: string, provider: Provider, rawKey: string, repoId?: string) {
  const column =
    provider === "openai"
      ? "openai_key_enc"
      : provider === "anthropic"
        ? "anthropic_key_enc"
        : "gemini_key_enc";

  const now = new Date().toISOString();
  const encrypted = encryptSecret(rawKey);

  if (repoId && repoId.trim()) {
    const normalizedRepoId = repoId.trim();
    getRepoRow(teamId, normalizedRepoId);
    db.prepare(
      `
      UPDATE repo_settings
      SET ${column} = ?, updated_at = ?
      WHERE team_id = ? AND repo_id = ?
      `
    ).run(encrypted, now, teamId, normalizedRepoId);
    return;
  }

  db.prepare(
    `
    UPDATE team_settings
    SET ${column} = ?, updated_at = ?
    WHERE team_id = ?
    `
  ).run(encrypted, now, teamId);
}

export function updateProviderDefaults(teamId: string, provider: Provider, model: string, repoId?: string) {
  const now = new Date().toISOString();
  if (repoId && repoId.trim()) {
    const normalizedRepoId = repoId.trim();
    getRepoRow(teamId, normalizedRepoId);
    db.prepare(
      "UPDATE repo_settings SET default_provider = ?, default_model = ?, updated_at = ? WHERE team_id = ? AND repo_id = ?"
    ).run(provider, model, now, teamId, normalizedRepoId);
    return;
  }

  db.prepare(
    "UPDATE team_settings SET default_provider = ?, default_model = ?, updated_at = ? WHERE team_id = ?"
  ).run(provider, model, now, teamId);
}

export function saveExternalDbUrl(teamId: string, rawUrl: string, repoId?: string) {
  const now = new Date().toISOString();
  const value = rawUrl.trim();
  const encrypted = value ? encryptSecret(value) : null;

  if (repoId && repoId.trim()) {
    const normalizedRepoId = repoId.trim();
    getRepoRow(teamId, normalizedRepoId);
    db.prepare(
      `
      UPDATE repo_settings
      SET external_db_url_enc = ?, updated_at = ?
      WHERE team_id = ? AND repo_id = ?
      `
    ).run(encrypted, now, teamId, normalizedRepoId);
    return;
  }

  db.prepare(
    `
    UPDATE team_settings
    SET external_db_url_enc = ?, updated_at = ?
    WHERE team_id = ?
    `
  ).run(encrypted, now, teamId);
}
