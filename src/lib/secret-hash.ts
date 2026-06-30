import { createHash, createHmac } from "node:crypto";

import { ServerEnvError } from "./env";

export type SecretHashPurpose = "csrf" | "session";

export function hashServerSecretValue(value: string, purpose: SecretHashPurpose): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new ServerEnvError(["SESSION_SECRET"]);
  }
  if (!secret) {
    return createHash("sha256").update(`${purpose}\u001f${value}`).digest("hex");
  }
  return createHmac("sha256", secret).update(purpose).update("\u001f").update(value).digest("hex");
}
