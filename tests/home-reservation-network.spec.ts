import { expect, test, type Page } from "@playwright/test";

import { e2eNow, FIXED_THURSDAY_DATE, mockClientDate } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type StudyPeriod = "EIGHTH" | "FIRST";

type MockUser = {
  readonly bookingStatus: "ACTIVE";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: null;
  readonly restrictedUntil: null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

type MockPeriod = {
  readonly applicants: readonly [];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly myReservationId: string | null;
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: StudyPeriod;
  readonly windowState: "open";
};

test("reserve confirmation posts before any dialog-stage period refresh", async ({ page }) => {
  let dialogVisible = false;
  let postStarted = false;
  let periodGetsBetweenDialogAndPost = 0;

  await routeMockCsrf(page);
  await routeMockLogin(page);
  await routeOpenPeriods(page, () => {
    if (dialogVisible && !postStarted) {
      periodGetsBetweenDialogAndPost += 1;
    }
  });
  await page.route("**/api/reservations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    postStarted = true;
    await route.fulfill({
      body: JSON.stringify({ reservation: { id: "network-reservation" } }),
      contentType: "application/json",
      status: 201
    });
  });

  await login(page);
  await page.locator(".period-card").first().locator(".period-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  dialogVisible = true;

  const reservationPost = page.waitForResponse(
    (response) => response.url().endsWith("/api/reservations") && response.request().method() === "POST"
  );
  await page.locator(".confirm-dialog .primary-button").click();
  await reservationPost;

  expect(periodGetsBetweenDialogAndPost).toBe(0);
});

async function login(page: Page): Promise<void> {
  await mockClientDate(page, e2eNow(FIXED_THURSDAY_DATE));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator("input").nth(0).fill(`network-${Date.now()}`);
  await page.locator("input").nth(1).fill("password");
  await page.locator(".login-form .primary-button").click();
  await expect(page.locator(".period-card .period-badge")).toHaveCount(2);
}

async function routeMockLogin(page: Page): Promise<void> {
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ user: buildMockUser() }),
      contentType: "application/json",
      status: 200
    });
  });
}

async function routeMockCsrf(page: Page): Promise<void> {
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ csrfToken: "network-test-csrf-token" }),
      contentType: "application/json",
      status: 200
    });
  });
}

async function routeOpenPeriods(page: Page, onPeriodsGet: () => void): Promise<void> {
  await page.route("**/api/periods**", async (route) => {
    onPeriodsGet();
    const date = new URL(route.request().url()).searchParams.get("date") ?? FIXED_THURSDAY_DATE;
    await route.fulfill({
      body: JSON.stringify({
        periods: [buildMockPeriod(date, "EIGHTH", "8면학"), buildMockPeriod(date, "FIRST", "1면학")]
      }),
      contentType: "application/json",
      status: 200
    });
  });
}

function buildMockUser(): MockUser {
  return {
    bookingStatus: "ACTIVE",
    generation: 31,
    id: "network-user",
    name: "테스트학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "90001"
  };
}

function buildMockPeriod(date: string, studyPeriod: StudyPeriod, label: string): MockPeriod {
  return {
    applicants: [],
    capacity: 10,
    closeTime: "23:59",
    confirmedCount: 0,
    date,
    enabled: true,
    label,
    myReservationId: null,
    openTime: "00:00",
    remaining: 10,
    studyPeriod,
    windowState: "open"
  };
}
