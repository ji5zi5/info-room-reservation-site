import type { Locator } from "@playwright/test";

export type VisibleBox = {
  readonly bottom: number;
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
};

export async function visibleBox(locator: Locator, label: string): Promise<VisibleBox> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label} should be visible`);
  }
  return { bottom: box.y + box.height, height: box.height, width: box.width, x: box.x, y: box.y };
}

export async function visiblePosition(locator: Locator, label: string): Promise<{ readonly x: number; readonly y: number }> {
  const box = await visibleBox(locator, label);
  return { x: box.x, y: box.y };
}
