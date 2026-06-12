import { createHash, randomBytes } from "node:crypto";

export type CsrfErrorReason = "csrf_expired" | "csrf_invalid" | "csrf_missing";

export type CsrfTokenRecord = {
  readonly expiresAt: Date;
  readonly sessionId: string;
  readonly tokenHash: string;
};

export type CsrfTokenStore = {
  readonly create: (record: CsrfTokenRecord) => Promise<void>;
  readonly findByHash: (tokenHash: string) => Promise<CsrfTokenRecord | null>;
};

export type CsrfValidationResult = { readonly kind: "ok" } | { readonly kind: "error"; readonly reason: CsrfErrorReason };

const CSRF_TTL_MS = 3 * 60 * 60 * 1000;

export async function mintCsrfToken(input: {
  readonly now: Date;
  readonly sessionId: string;
  readonly store: CsrfTokenStore;
}): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await input.store.create({
    expiresAt: new Date(input.now.getTime() + CSRF_TTL_MS),
    sessionId: input.sessionId,
    tokenHash: hashCsrfToken(token)
  });
  return token;
}

export async function validateCsrfToken(input: {
  readonly now: Date;
  readonly sessionId: string;
  readonly store: CsrfTokenStore;
  readonly token: string | null;
}): Promise<CsrfValidationResult> {
  if (!input.token) {
    return { kind: "error", reason: "csrf_missing" };
  }

  const record = await input.store.findByHash(hashCsrfToken(input.token));
  if (!record || record.sessionId !== input.sessionId) {
    return { kind: "error", reason: "csrf_invalid" };
  }
  if (record.expiresAt.getTime() <= input.now.getTime()) {
    return { kind: "error", reason: "csrf_expired" };
  }

  return { kind: "ok" };
}

export function messageForCsrfError(reason: CsrfErrorReason): string {
  switch (reason) {
    case "csrf_expired":
      return "보안 토큰이 만료되었습니다. 새로고침 후 다시 시도해주세요.";
    case "csrf_invalid":
      return "보안 토큰이 올바르지 않습니다.";
    case "csrf_missing":
      return "보안 토큰이 필요합니다.";
  }
}

export function hashCsrfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
