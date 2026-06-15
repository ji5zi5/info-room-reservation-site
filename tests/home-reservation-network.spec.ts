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

test("reserve click requires a directly typed reason and posts without extra period refreshes", async ({ page }) => {
  let reserveClickStarted = false;
  let dialogVisible = false;
  let postStarted = false;
  let periodGetsBetweenClickAndDialog = 0;
  let periodGetsBetweenDialogAndPost = 0;
  let postedReservationBody: unknown = null;

  await routeMockCsrf(page);
  await routeMockLogin(page);
  await routeOpenPeriods(page, () => {
    if (reserveClickStarted && !dialogVisible) {
      periodGetsBetweenClickAndDialog += 1;
    }
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
    postedReservationBody = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({
      body: JSON.stringify({ reservation: { id: "network-reservation" } }),
      contentType: "application/json",
      status: 201
    });
  });

  await login(page);
  reserveClickStarted = true;
  await page.locator(".period-card").first().locator(".period-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  dialogVisible = true;
  const confirmButton = page.locator(".confirm-dialog .primary-button");
  const reasonInput = page.getByLabel("이용 사유");
  await expect(reasonInput).toBeVisible();
  await expect(confirmButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "자습" })).toBeHidden();
  await reasonInput.fill("조용한 자리에서 수행평가 준비");
  await expect(reasonInput).toHaveValue("조용한 자리에서 수행평가 준비");

  const reservationPost = page.waitForResponse(
    (response) => response.url().endsWith("/api/reservations") && response.request().method() === "POST"
  );
  await confirmButton.click();
  await reservationPost;

  expect(periodGetsBetweenClickAndDialog).toBe(0);
  expect(periodGetsBetweenDialogAndPost).toBe(0);
  expect(postedReservationBody).toEqual({
    date: FIXED_THURSDAY_DATE,
    reason: "조용한 자리에서 수행평가 준비",
    studyPeriod: "EIGHTH"
  });
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
