import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const VercelConfigSchema = z
  .object({
    regions: z.array(z.string()).optional()
  })
  .passthrough();

describe("vercel function region", () => {
  it("declares the regions key only once", () => {
    const rawConfig = readFileSync(resolve(process.cwd(), "vercel.json"), "utf8");
    const regionKeyMatches = rawConfig.match(/"regions"\s*:/g) ?? [];

    expect(regionKeyMatches).toHaveLength(1);
  });

  it("pins functions to Seoul", () => {
    const rawConfig = readFileSync(resolve(process.cwd(), "vercel.json"), "utf8");
    const config = VercelConfigSchema.parse(JSON.parse(rawConfig));

    expect(config.regions).toEqual(["icn1"]);
  });
});
