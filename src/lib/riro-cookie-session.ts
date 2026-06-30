const RIRO_FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome"
} as const;

export class RiroCookieJar {
  private readonly cookies = new Map<string, string>();

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  storeFromHeaders(headers: Pick<Headers, "get">): void {
    for (const setCookie of readSetCookieHeaders(headers)) {
      const pair = setCookie.split(";", 1)[0]?.trim();
      if (!pair) {
        continue;
      }
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);
      if (value === "deleted" || isExpiredCookie(setCookie)) {
        this.cookies.delete(name);
        continue;
      }
      this.cookies.set(name, value);
    }
  }

  toHeader(): string | null {
    const values = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`);
    return values.length > 0 ? values.join("; ") : null;
  }
}

export function buildRiroHeaders(cookieJar: RiroCookieJar): Record<string, string> {
  const cookie = cookieJar.toHeader();
  if (!cookie) {
    return { ...RIRO_FORM_HEADERS };
  }
  return {
    ...RIRO_FORM_HEADERS,
    cookie
  };
}

function readSetCookieHeaders(headers: Pick<Headers, "get">): readonly string[] {
  const getSetCookie = "getSetCookie" in headers ? headers.getSetCookie : undefined;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(headers);
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies.filter((cookie): cookie is string => typeof cookie === "string");
    }
  }
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function splitSetCookieHeader(header: string): readonly string[] {
  return header.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/u).map((part) => part.trim()).filter(Boolean);
}

function isExpiredCookie(setCookie: string): boolean {
  return /;\s*max-age=0(?:;|$)/iu.test(setCookie) || /expires=Thu,\s*01\s*Jan\s*1970/iu.test(setCookie);
}
