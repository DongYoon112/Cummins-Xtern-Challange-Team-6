import crypto from "node:crypto";

export type EncryptedSecret = {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

const IV_LENGTH = 12;

function parseMasterKey(raw?: string): Buffer {
  const value = raw ?? process.env.MASTER_KEY;
  if (!value) {
    throw new Error("MASTER_KEY is required for encryption operations");
  }

  const normalized = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return Buffer.from(normalized, "hex");
  }

  const fromBase64 = Buffer.from(normalized, "base64");
  if (fromBase64.length === 32) {
    return fromBase64;
  }

  throw new Error("MASTER_KEY must be 32 bytes in hex (64 chars) or base64");
}

export function encryptSecret(plainText: string, explicitMasterKey?: string): string {
  const key = parseMasterKey(explicitMasterKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedSecret = {
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  return JSON.stringify(payload);
}

export function decryptSecret(encrypted: string, explicitMasterKey?: string): string {
  const payload = JSON.parse(encrypted) as EncryptedSecret;
  if (payload.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported encryption algorithm: ${payload.alg}`);
  }

  const key = parseMasterKey(explicitMasterKey);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function maskSecret(secret: string): string {
  if (!secret) {
    return "";
  }
  const prefix = secret.slice(0, Math.min(5, secret.length));
  return `${prefix}...`;
}
