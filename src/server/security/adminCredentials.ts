import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createToken(prefix = "mc"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, saltText, digestText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) return false;
  const expected = Buffer.from(digestText, "base64");
  const actual = scryptSync(password, Buffer.from(saltText, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export class SecretBox {
  private readonly key: Buffer;

  public constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.length !== 32) throw new Error("MENTOR_SETTINGS_MASTER_KEY must be a Base64-encoded 32-byte key.");
  }

  public encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  public decrypt(value: string): string {
    const [ivText, tagText, ciphertextText] = value.split(".");
    if (!ivText || !tagText || !ciphertextText) throw new Error("Encrypted setting is malformed.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  }
}
