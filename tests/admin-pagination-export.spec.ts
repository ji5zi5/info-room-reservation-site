import { expect, test, type Download, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test("student traversal resets filters, dedupes next pages, expires safely, and isolates stale reads", async ({ page }) => {
  const fixture = await mockPagedAdminConsole(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "학생" }).click();

  await expect(page.getByText("2개 표시 / 현재 4건", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(page.getByText("3개 표시 / 현재 3건", { exact: true })).toBeVisible();
  await expect(page.getByText("중복학생", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "탐색 완료" })).toBeDisabled();

  const search = page.getByLabel("이름 또는 학번");
  await search.fill("filtered");
  await expect(page.getByText("필터학생", { exact: true })).toBeVisible();
  expect(fixture.userRequests.at(-1)?.searchParams.has("cursor")).toBe(false);

  await search.fill("expiry");
  await expect(page.getByText("유지학생", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(page.getByRole("button", { name: "처음부터 다시" })).toBeVisible();
  await expect(page.getByText("유지학생", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "처음부터 다시" }).click();
  await expect(page.getByText("새출발학생", { exact: true })).toBeVisible();
  await expect(page.getByText("유지학생", { exact: true })).toHaveCount(0);

  await search.fill("empty");
  await expect(page.getByText("빈페이지유지학생", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(page.getByText("빈페이지유지학생", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "더 보기" })).toBeEnabled();

  await search.fill("slow");
  await expect.poll(() => fixture.userRequests.some((url) => url.searchParams.get("query") === "slow")).toBe(true);
  await search.fill("fast");
  await expect(page.getByText("빠른학생", { exact: true })).toBeVisible();
  fixture.releaseSlowUser();
  await expect(page.getByText("느린학생", { exact: true })).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  await search.fill("");
  await expect(page.getByText("첫째학생", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "학생 관리" })).toBeVisible();
  await expect.poll(() => horizontalOverflow(page)).toBe(false);
  await page.getByRole("button", { name: "더 보기" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "더 보기" }).focus();
  await expect(page.getByRole("button", { name: "더 보기" })).toBeFocused();
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-16-admin-pagination-mobile-390x844.png") });
});

test("reservation and audit controls download the full filtered server CSV", async ({ page }) => {
  const fixture = await mockPagedAdminConsole(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "예약자" }).click();
  await expect(page.getByText("2개 표시 / 현재 3건", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(page.getByText("3개 표시 / 현재 2건", { exact: true })).toBeVisible();
  await expect(page.getByText("예약중복", { exact: true })).toHaveCount(1);
  const reservationExportSearch = await exportSearch(page);
  await assertCsvDownload(
    page,
    "admin-reservations.csv",
    "날짜,시간대,상태,이름,학번,사유",
    4
  );
  expect(fixture.reservationExportRequests).toHaveLength(1);
  expect(fixture.reservationExportRequests[0]?.search).toBe(reservationExportSearch);
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-16-admin-pagination-desktop-1440x900.png") });

  await page.getByRole("button", { name: "감사" }).click();
  await expect(page.getByText("1개 표시 / 현재 2건", { exact: true })).toBeVisible();
  const auditExportSearch = await exportSearch(page);
  await assertCsvDownload(
    page,
    "admin-audit-actions.csv",
    "시각,분류,액션,처리자,처리자학번,대상,대상학번,사유,예약ID",
    3
  );
  expect(fixture.auditExportRequests).toHaveLength(1);
  expect(fixture.auditExportRequests[0]?.search).toBe(auditExportSearch);
});

test("an exact audit URL focuses its record without traversing list pages", async ({ page }) => {
  const fixture = await mockPagedAdminConsole(page);
  await page.goto(`${BASE_URL}/?section=audit&action=audit-exact`, { waitUntil: "networkidle" });

  const exact = page.locator('[data-focus-target="true"]');
  await expect(exact).toContainText("정확한 감사 기록");
  await expect(exact).toBeFocused();
  const exactRequests = fixture.auditRequests.filter((url) => url.searchParams.get("actionId") === "audit-exact");
  expect(exactRequests.length).toBeGreaterThan(0);
  expect(exactRequests.every((url) => !url.searchParams.has("cursor"))).toBe(true);
});

async function assertCsvDownload(
  page: Page,
  filename: string,
  expectedHeader: string,
  expectedLineCount: number
): Promise<void> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "CSV 다운로드" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  const csv = await readDownload(download);
  expect(csv.replace(/^\uFEFF/u, "").split(/\r?\n/u)[0]).toBe(expectedHeader);
  expect(csv.replace(/^\uFEFF/u, "").trimEnd().split(/\r?\n/u)).toHaveLength(expectedLineCount);
}

async function readDownload(download: Download): Promise<string> {
  const path = await download.path();
  if (path === null) throw new Error("download did not produce a local file");
  return readFile(path, "utf8");
}

async function mockPagedAdminConsole(page: Page) {
  const auditExportRequests: URL[] = [];
  const userRequests: URL[] = [];
  const auditRequests: URL[] = [];
  const reservationExportRequests: URL[] = [];
  let expiryBaseReads = 0;
  let releaseSlow = (): void => {};
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: adminUser } }));
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "todo-16-csrf" } }));
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/api/admin/period-settings": return fulfill(route, { periods });
      case "/api/admin/notification-settings": return fulfill(route, { notificationSettings });
      case "/api/admin/dashboard": return fulfill(route, { notificationBacklog: [], periods: dashboardPeriods });
      case "/api/admin/statistics": return fulfill(route, { statistics });
      case "/api/admin/operations": return fulfill(route, emptyOperations);
      case "/api/admin/users": {
        userRequests.push(url);
        const exactUserId = url.searchParams.get("userId");
        if (exactUserId) return fulfill(route, pageOf([user(exactUserId, "정확한학생")], null, 1));
        const query = url.searchParams.get("query") ?? "";
        const cursor = url.searchParams.get("cursor");
        if (cursor === "expired") return fulfill(route, { error: { code: "CURSOR_EXPIRED", message: "cursor expired" } }, 400);
        if (cursor === "users-2") return fulfill(route, pageOf([user("user-2", "중복학생"), user("user-3", "셋째학생")], null, 3));
        if (query === "filtered") return fulfill(route, pageOf([user("filtered", "필터학생")], null, 1));
        if (query === "expiry") {
          expiryBaseReads += 1;
          return fulfill(route, pageOf([
            expiryBaseReads === 1 ? user("keep", "유지학생") : user("fresh", "새출발학생")
          ], expiryBaseReads === 1 ? "expired" : null, 1));
        }
        if (query === "empty" && cursor === "empty-terminal") return fulfill(route, pageOf([], null, 1));
        if (query === "empty") return fulfill(route, pageOf([user("empty-keep", "빈페이지유지학생")], "empty-terminal", 1));
        if (query === "slow") {
          await slowGate;
          return fulfill(route, pageOf([user("slow", "느린학생")], null, 1));
        }
        if (query === "fast") return fulfill(route, pageOf([user("fast", "빠른학생")], null, 1));
        return fulfill(route, pageOf([user("user-1", "첫째학생"), user("user-2", "중복학생")], "users-2", 4));
      }
      case "/api/admin/reservations": {
        if (url.searchParams.has("reservationId")) return fulfill(route, pageOf([reservation("reservation-exact", "정확예약")], null, 1));
        if (url.searchParams.get("cursor") === "reservations-2") {
          return fulfill(route, pageOf([reservation("reservation-2", "예약중복"), reservation("reservation-3", "예약셋")], null, 2));
        }
        return fulfill(route, pageOf([reservation("reservation-1", "예약하나"), reservation("reservation-2", "예약중복")], "reservations-2", 3));
      }
      case "/api/admin/actions": {
        auditRequests.push(url);
        if (url.searchParams.get("actionId") === "audit-exact") {
          return fulfill(route, pageOf([auditAction("audit-exact", "정확한 감사 기록")], null, 1));
        }
        return fulfill(route, pageOf([auditAction("audit-1", "감사 하나")], "audit-2", 2));
      }
      case "/api/admin/exports/reservations":
        reservationExportRequests.push(url);
        return csv(route, reservationCsv, "admin-reservations.csv");
      case "/api/admin/exports/actions":
        auditExportRequests.push(url);
        return csv(route, auditCsv, "admin-audit-actions.csv");
      default: return fulfill(route, { error: { message: `Unexpected ${url.pathname}` } }, 404);
    }
  });
  return { auditExportRequests, auditRequests, releaseSlowUser: releaseSlow, reservationExportRequests, userRequests };
}

async function exportSearch(page: Page): Promise<string> {
  const href = await page.getByRole("link", { name: "CSV 다운로드" }).getAttribute("href");
  if (href === null) throw new Error("CSV download link is missing its href");
  return new URL(href, BASE_URL).search;
}

function user(id: string, name: string) {
  return { bookingStatus: "ACTIVE", generation: 31, id, name, restrictedUntil: null, restrictionReason: null, role: "STUDENT", shadowBanProfile: "NORMAL", studentNumber: `31-${id}` };
}

function reservation(id: string, name: string) {
  return { createdAt: "2026-08-13T00:00:00.000Z", date: "2026-08-13", id, reason: "학습", status: "CONFIRMED", studyPeriod: "EIGHTH", user: { bookingStatus: "ACTIVE", id: `user-${id}`, name, role: "STUDENT", studentNumber: `31-${id}` } };
}

function auditAction(id: string, reason: string) {
  return { action: "USER_RESTRICTION_APPLY", actor: null, actorId: null, after: null, before: null, category: "RESTRICTION", createdAt: "2026-08-13T00:00:00.000Z", id, reason, reservationId: null, targetUser: null, targetUserId: null };
}

function pageOf(items: readonly unknown[], nextCursor: string | null, currentTotalCount: number) {
  return { cutoff: "2026-08-13T00:00:00.000Z", currentTotalCount, expiresAt: "2026-08-13T00:15:00.000Z", items, nextCursor };
}

async function fulfill(route: Route, json: unknown, status = 200): Promise<void> {
  await route.fulfill({ contentType: "application/json", json, status });
}

async function csv(route: Route, body: string, filename: string): Promise<void> {
  await route.fulfill({
    body: `\uFEFF${body}`,
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8"
    }
  });
}

async function horizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

function requiredEvidenceDir(): string {
  const value = process.env.EVIDENCE_DIR;
  if (!value) throw new Error("EVIDENCE_DIR is required.");
  return value;
}

const adminUser = { bookingStatus: "ACTIVE", generation: 0, id: "admin-1", name: "관리자", restrictedUntil: null, restrictionReason: null, role: "ADMIN", studentNumber: "0" };
const periods = [{ capacity: 10, closeTime: "16:20", confirmedCount: 0, date: "2026-08-13", enabled: true, label: "8면학", openTime: "13:00", remaining: 10, studyPeriod: "EIGHTH", windowState: "closed" }, { capacity: 10, closeTime: "17:20", confirmedCount: 0, date: "2026-08-13", enabled: true, label: "1면학", openTime: "14:00", remaining: 10, studyPeriod: "FIRST", windowState: "closed" }];
const dashboardPeriods = periods.map((period) => ({ ...period, applicants: [], isClosed: true, notification: null }));
const notificationSettings = { closedPeriodNotificationsEnabled: true, id: "global", reservationCreatedNotificationsEnabled: false };
const statistics = { dailyStats: [], from: "2026-08-13", periodStats: [], repeatedOffenders: [], to: "2026-08-13", totals: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0, totalCount: 0, uniqueStudentCount: 0 } };
const emptyOperations = {
  backlogs: { initialSends: { count: 0, items: [], oldestAgeMs: null }, interactions: { count: 0, items: [], oldestAgeMs: null }, syncs: { count: 0, items: [], oldestAgeMs: null } },
  control: { enabled: true, epoch: 1, pendingRemoteCleanup: false },
  generatedAt: "2026-08-13T00:00:00.000Z",
  jobs: ["CLOSED_PERIOD_NOTIFICATIONS", "DISCORD_INTERACTIONS", "DISCORD_RESERVATION_OUTBOX"].map((job) => ({
    backlogCount: 0,
    failureCode: null,
    health: { code: "healthy", status: "ok" },
    job,
    lastAttemptAt: "2026-08-13T00:00:00.000Z",
    lastSuccessAt: "2026-08-13T00:00:00.000Z",
    status: "SUCCEEDED"
  }))
};
const reservationCsv = "날짜,시간대,상태,이름,학번,사유\n2026-08-13,8면학,CONFIRMED,예약하나,31001,학습\n2026-08-13,8면학,CONFIRMED,예약중복,31002,학습\n2026-08-13,8면학,CONFIRMED,예약셋,31003,학습";
const auditCsv = "시각,분류,액션,처리자,처리자학번,대상,대상학번,사유,예약ID\n2026-08-13T00:00:00.000Z,RESTRICTION,USER_RESTRICTION_APPLY,,,,,감사 하나,\n2026-08-13T00:01:00.000Z,RESTRICTION,USER_RESTRICTION_APPLY,,,,,감사 둘,";
