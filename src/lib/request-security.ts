import { parseServerEnv } from "./env";

export type MutatingRequestSafetyError = {
  readonly code: "origin_forbidden" | "fetch_metadata_forbidden";
  readonly message: string;
};

const SAFE_FETCH_SITES = new Set(["none", "same-origin", "same-site"]);

export function requireMutatingRequestSafety(request: Request): MutatingRequestSafetyError | null {
  const originError = getOriginSafetyError(request);
  if (originError) {
    return originError;
  }

  return getFetchMetadataSafetyError(request);
}

export function isSameOriginRequest(request: Request): boolean {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) {
    return true;
  }

  const origin = parseOrigin(requestOrigin);
  if (origin === null) {
    return false;
  }

  return origin === parseOrigin(request.url) || origin === parseServerEnv().appOrigin;
}

export function isFetchMetadataAllowed(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return !fetchSite || SAFE_FETCH_SITES.has(fetchSite);
}

export function parseTrustedOrigin(request: Request): string | null {
  return parseOrigin(request.url);
}

function getOriginSafetyError(request: Request): MutatingRequestSafetyError | null {
  if (isSameOriginRequest(request)) {
    return null;
  }

  return {
    code: "origin_forbidden",
    message: "요청 출처가 허용되지 않습니다."
  };
}

function getFetchMetadataSafetyError(request: Request): MutatingRequestSafetyError | null {
  if (isFetchMetadataAllowed(request)) {
    return null;
  }

  return {
    code: "fetch_metadata_forbidden",
    message: "교차 사이트 요청은 허용되지 않습니다."
  };
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
