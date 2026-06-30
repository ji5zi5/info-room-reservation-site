import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STYLE_FILES = [
  "src/app/styles/admin.css",
  "src/app/styles/base.css",
  "src/app/styles/components.css",
  "src/app/styles/layout.css",
  "src/app/styles/reservation-calendar.css"
] as const;

const RAW_COLOR_FILES = [
  ...STYLE_FILES,
  "src/app/reservation-sidebar.tsx",
  "src/components/reservation-period-card.tsx"
] as const;

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("DESIGN.md visual constraints", () => {
  it("keeps app styles free of shadow, gradient, and translate/scale UI motion", () => {
    for (const file of STYLE_FILES) {
      const content = source(file);

      expect(content, `${file} should not use shadow elevation`).not.toMatch(/\bbox-shadow\s*:/u);
      expect(content, `${file} should not use decorative gradients`).not.toMatch(/\blinear-gradient\(/u);
      expect(content, `${file} should not derive ad hoc colors with color-mix`).not.toMatch(/\bcolor-mix\(/u);
      expect(content, `${file} should not use ad hoc rgba overlays`).not.toMatch(/\brgba\(/u);
      expect(content, `${file} should not use red as a semantic UI status color`).not.toMatch(/\bvar\(--red\)/u);
      expect(content, `${file} should keep typography within DESIGN.md weight limits`).not.toMatch(
        /(?:font-weight\s*:\s*(?:[6-9]00|var\(--weight-bold\))|--weight-bold\s*:)/u
      );
      expect(content, `${file} should use typography tokens instead of raw rem font sizes`).not.toMatch(
        /\bfont-size\s*:\s*\d*\.?\d+rem\b/u
      );
      expect(content, `${file} should not animate position or scale`).not.toMatch(
        /\btransform\s*:[^;]*(?:translate[XYZ]?\(|scale\()/u
      );
    }
  });

  it("keeps literal hex colors centralized in tokens.css", () => {
    for (const file of RAW_COLOR_FILES) {
      expect(source(file), `${file} should use design tokens instead of raw hex colors`).not.toMatch(
        /#[0-9a-f]{3,8}\b/iu
      );
    }
  });

  it("keeps dimensional CSS values tokenized outside media-query breakpoints", () => {
    for (const file of STYLE_FILES) {
      const rawDimensionLines = source(file)
        .split(/\r?\n/u)
        .filter((line) => /\d*\.?\d+(?:px|rem)\b/u.test(line))
        .filter((line) => !/^\s*@media\b/u.test(line));

      expect(rawDimensionLines, `${file} should centralize px/rem values in tokens.css`).toEqual([]);
    }
  });
});
