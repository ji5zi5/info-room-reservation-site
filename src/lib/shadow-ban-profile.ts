export const SHADOW_BAN_PROFILES = ["LOW", "NORMAL", "HIGH"] as const;

export type ShadowBanProfile = (typeof SHADOW_BAN_PROFILES)[number];

export const DEFAULT_SHADOW_BAN_PROFILE = "NORMAL" satisfies ShadowBanProfile;

const SHADOW_BAN_PROFILE_LABELS = {
  HIGH: "높음",
  LOW: "낮음",
  NORMAL: "보통"
} as const satisfies Record<ShadowBanProfile, string>;

export function parseShadowBanProfile(value: string | null | undefined): ShadowBanProfile {
  switch (value) {
    case "HIGH":
    case "LOW":
    case "NORMAL":
      return value;
    default:
      return DEFAULT_SHADOW_BAN_PROFILE;
  }
}

export function shadowBanProfileLabel(profile: ShadowBanProfile): string {
  return SHADOW_BAN_PROFILE_LABELS[profile];
}
