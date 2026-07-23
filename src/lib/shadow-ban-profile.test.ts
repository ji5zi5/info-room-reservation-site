import { describe, expect, it } from "vitest";

import {
  DEFAULT_SHADOW_BAN_PROFILE,
  parseShadowBanProfile,
  shadowBanProfileLabel
} from "./shadow-ban-profile";

describe("shadow-ban profile", () => {
  it("parses only the low normal high profile values", () => {
    expect(parseShadowBanProfile("LOW")).toBe("LOW");
    expect(parseShadowBanProfile("NORMAL")).toBe("NORMAL");
    expect(parseShadowBanProfile("HIGH")).toBe("HIGH");
    expect(parseShadowBanProfile("OBSERVE")).toBe(DEFAULT_SHADOW_BAN_PROFILE);
    expect(parseShadowBanProfile(null)).toBe(DEFAULT_SHADOW_BAN_PROFILE);
  });

  it("labels the three admin-facing profiles in Korean", () => {
    expect(shadowBanProfileLabel("LOW")).toBe("낮음");
    expect(shadowBanProfileLabel("NORMAL")).toBe("보통");
    expect(shadowBanProfileLabel("HIGH")).toBe("높음");
  });
});
