import { expect, test, type Page, type Route } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type AdminRequest = {
  readonly method: string;
  readonly pathname: string;
  readonly query: string;
};

test("admin initial load fetches shared settings and the active section only", async ({ page }) => {
  const requests: AdminRequest[] = [];
  await mockAdminConsole(page, requests);
  await openAdminConsole(page);

  const paths = new Set(readRequests(requests).map((request) => request.pathname));
  expect(paths).toEqual(
    new Set([
      "/api/admin/dashboard",
      "/api/admin/notification-settings",
      "/api/admin/period-settings",
      "/api/admin/statistics",
    ]),
  );
});

test("admin search is debounced and a stale response cannot replace the latest result", async ({
  page,
}) => {
  const requests: AdminRequest[] = [];
  await mockAdminConsole(page, requests);
  await openAdminConsole(page);
  await page.getByRole("button", { name: "학생" }).click();
  await expect(page.getByRole("heading", { name: "학생 관리" })).toBeVisible();
  await expect.poll(() => userReads(requests).length).toBeGreaterThan(0);

  requests.length = 0;
  const search = page.getByLabel("이름 또는 학번");
  await search.fill("감");
  await search.fill("감자");
  await search.fill("감자칩");
  await page.waitForTimeout(350);

  expect(userReads(requests)).toHaveLength(1);
  expect(new URLSearchParams(userReads(requests)[0]?.query).get("query")).toBe("감자칩");

  requests.length = 0;
  await search.fill("slow");
  await expect
    .poll(() => userReads(requests).some((request) => new URLSearchParams(request.query).get("query") === "slow"))
    .toBe(true);
  await search.fill("fast");

  await expect(page.getByText("빠른학생")).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByText("빠른학생")).toBeVisible();
  await expect(page.getByText("느린학생")).toHaveCount(0);
});

test("saving settings refreshes settings without reloading unrelated sections", async ({ page }) => {
  const requests: AdminRequest[] = [];
  await mockAdminConsole(page, requests);
  await openAdminConsole(page);
  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("heading", { name: "시간 설정" })).toBeVisible();
  await page.waitForTimeout(150);

  requests.length = 0;
  await page.getByRole("button", { name: "저장" }).click();
  await expect.poll(() => requests.filter((request) => request.method === "PATCH").length).toBe(2);
  await expect
    .poll(() => new Set(readRequests(requests).map((request) => request.pathname)))
    .toEqual(new Set(["/api/admin/notification-settings", "/api/admin/period-settings"]));
});

async function openAdminConsole(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "운영 대시보드" })).toBeVisible();
}

async function mockAdminConsole(page: Page, requests: AdminRequest[]): Promise<void> {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        user: {
          bookingStatus: "ACTIVE",
          generation: 0,
          id: "admin-request-scope",
          name: "관리자",
          restrictedUntil: null,
          restrictionReason: null,
          role: "ADMIN",
          studentNumber: "0",
        },
      },
    });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { csrfToken: "admin-request-scope-csrf" },
    });
  });
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      method: request.method(),
      pathname: url.pathname,
      query: url.search.slice(1),
    });
    await fulfillAdminRequest(route, url);
  });
}

async function fulfillAdminRequest(route: Route, url: URL): Promise<void> {
  const method = route.request().method();
  if (method !== "GET") {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
    return;
  }
  switch (url.pathname) {
    case "/api/admin/period-settings":
      await route.fulfill({ contentType: "application/json", json: { periods: adminPeriods() } });
      return;
    case "/api/admin/notification-settings":
      await route.fulfill({
        contentType: "application/json",
        json: {
          notificationSettings: {
            closedPeriodNotificationsEnabled: true,
            id: "global",
            reservationCreatedNotificationsEnabled: false,
          },
        },
      });
      return;
    case "/api/admin/dashboard":
      await route.fulfill({
        contentType: "application/json",
        json: {
          notificationBacklog: [],
          periods: adminPeriods().map((period) => ({
            ...period,
            applicants: [],
            isClosed: false,
            notification: null,
          })),
        },
      });
      return;
    case "/api/admin/statistics":
      await route.fulfill({
        contentType: "application/json",
        json: {
          statistics: {
            dailyStats: [],
            from: "2026-07-24",
            periodStats: [],
            repeatedOffenders: [],
            to: "2026-07-24",
            totals: {
              cancelledCount: 0,
              confirmedCount: 0,
              noShowCount: 0,
              totalCount: 0,
              uniqueStudentCount: 0,
            },
          },
        },
      });
      return;
    case "/api/admin/reservations":
      await route.fulfill({ contentType: "application/json", json: { reservations: [] } });
      return;
    case "/api/admin/actions":
      await route.fulfill({ contentType: "application/json", json: { actions: [] } });
      return;
    case "/api/admin/users": {
      const query = url.searchParams.get("query") ?? "";
      if (query === "slow") {
        await delay(600);
      }
      const user =
        query === "slow"
          ? adminUser("slow-user", "느린학생")
          : query === "fast"
            ? adminUser("fast-user", "빠른학생")
            : adminUser("default-user", "기본학생");
      if (route.request().failure() === null) {
        await route.fulfill({ contentType: "application/json", json: { users: [user] } });
      }
      return;
    }
    default:
      await route.fulfill({
        contentType: "application/json",
        json: { error: { message: "Unexpected admin route" } },
        status: 404,
      });
  }
}

function adminPeriods() {
  return [
    adminPeriod("EIGHTH", "8면학", "20:00", "21:00"),
    adminPeriod("FIRST", "1면학", "21:00", "22:00"),
  ];
}

function adminPeriod(
  studyPeriod: "EIGHTH" | "FIRST",
  label: "8면학" | "1면학",
  openTime: string,
  closeTime: string,
) {
  return {
    capacity: 10,
    closeTime,
    confirmedCount: 0,
    date: "2026-07-24",
    enabled: true,
    label,
    openTime,
    remaining: 10,
    studyPeriod,
    windowState: "open",
  };
}

function adminUser(id: string, name: string) {
  return {
    bookingStatus: "ACTIVE",
    generation: 25,
    id,
    name,
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    shadowBanProfile: "NORMAL",
    studentNumber: `25-${id}`,
  };
}

function readRequests(requests: readonly AdminRequest[]): readonly AdminRequest[] {
  return requests.filter((request) => request.method === "GET");
}

function userReads(requests: readonly AdminRequest[]): readonly AdminRequest[] {
  return readRequests(requests).filter((request) => request.pathname === "/api/admin/users");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
