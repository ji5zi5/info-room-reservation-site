import { expect, test, type Page, type Route } from "@playwright/test";
import { join } from "node:path";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test("operations command center repairs and opens exact related records at desktop and mobile", async ({ page }) => {
  const fixture = await mockOperationsConsole(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const panel = page.getByRole("region", { name: "운영 작업 상태" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("정상", { exact: true })).toBeVisible();
  await expect(panel.getByText("실행 지연", { exact: true })).toBeVisible();
  await expect(panel.getByText("실행 시간 초과", { exact: true })).toBeVisible();
  await expect(panel.getByText("가장 오래된 항목 2시간", { exact: false })).toBeVisible();
  const reviewRow = page.getByRole("region", { name: "초기 전송" }).locator(".admin-operation-row");
  await expect(reviewRow.getByRole("button", { name: "원격 확인" })).toBeVisible();
  await expect(reviewRow.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-15-operations-desktop-1440x900.png") });

  await page.setViewportSize({ height: 844, width: 390 });
  await panel.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-15-operations-mobile-390x844.png") });

  const dashboardReadsBeforeRepair = fixture.dashboardReads;
  const retryRow = page.getByRole("region", { name: "Discord 명령" }).locator(".admin-operation-row").filter({ hasText: "discord_http_500" });
  await retryRow.getByRole("button", { name: "다시 시도" }).click();
  await expect(retryRow).toHaveCount(0);
  expect(fixture.dashboardReads).toBe(dashboardReadsBeforeRepair);
  expect(fixture.repairRequests).toHaveLength(1);

  await reviewRow.getByRole("button", { name: "예약 보기" }).click();
  await expect(page.getByRole("heading", { name: "예약자 목록" })).toBeVisible();
  await expect(page.getByText("운영학생", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "운영" }).click();
  await page.getByRole("region", { name: "초기 전송" }).getByRole("button", { name: "학생 보기" }).click();
  await expect(page.getByRole("heading", { name: "학생 관리" })).toBeVisible();
  await expect(page.getByText("31001 · 1기", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "운영" }).click();
  await page.getByRole("region", { name: "초기 전송" }).getByRole("button", { name: "감사 기록 보기" }).click();
  await expect(page.getByRole("heading", { name: "감사 로그" })).toBeVisible();
  await expect(page.getByText("운영 복구", { exact: true })).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test("destructive 409 keeps its row and malformed or missing audit links are cleaned", async ({ page }) => {
  const fixture = await mockOperationsConsole(page, { conflict: true });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const reviewRow = page.getByRole("region", { name: "초기 전송" }).locator(".admin-operation-row");
  await reviewRow.getByRole("button", { name: "처리 종료" }).click();
  await expect(page.getByRole("dialog", { name: "처리 종료 확인" })).toBeVisible();
  expect(fixture.repairRequests).toHaveLength(0);
  await page.getByRole("dialog", { name: "처리 종료 확인" }).getByRole("button", { name: "처리 종료" }).click();
  await expect(page.getByRole("dialog", { name: "처리 종료 확인" }).getByRole("alert")).toHaveText("Discord 복구 충돌: stale_state");
  await expect(reviewRow).toHaveCount(1);

  await page.goto(`${BASE_URL}/?section=audit&action=bad%2Faction`, { waitUntil: "networkidle" });
  await expect(page).not.toHaveURL(/section=|action=/u);
  await expect(page.getByText("운영 링크가 올바르지 않습니다.", { exact: true })).toBeVisible();
  await page.goto(`${BASE_URL}/?section=audit&action=audit-missing`, { waitUntil: "networkidle" });
  await expect(page).not.toHaveURL(/section=|action=/u);
  await expect(page.getByText("관련 운영 기록을 찾을 수 없습니다.", { exact: true })).toBeVisible();
});

test("an older operations response cannot replace the current dashboard generation", async ({ page }) => {
  const fixture = await mockOperationsConsole(page, { holdFirstOperations: true });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  await page.getByRole("button", { name: "예약자" }).click();
  await page.getByRole("button", { name: "운영" }).click();
  await expect(page.getByRole("region", { name: "운영 작업 상태" })).toBeVisible();
  fixture.releaseFirstOperations();
  await expect(page.getByText("old_response", { exact: true })).toHaveCount(0);
});

async function mockOperationsConsole(page: Page, options: { readonly conflict?: boolean; readonly holdFirstOperations?: boolean } = {}) {
  const errors: string[] = [];
  const repairRequests: Array<Record<string, unknown>> = [];
  let dashboardReads = 0;
  let repaired = false;
  let operationsReads = 0;
  let releaseFirst = (): void => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: adminUser } }));
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "csrf-test" } }));
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/api/admin/period-settings": return fulfill(route, { periods });
      case "/api/admin/notification-settings": return fulfill(route, { notificationSettings });
      case "/api/admin/dashboard": dashboardReads += 1; return fulfill(route, { notificationBacklog: [], periods: dashboardPeriods });
      case "/api/admin/statistics": return fulfill(route, { statistics });
      case "/api/admin/operations": {
        operationsReads += 1;
        if (options.holdFirstOperations && operationsReads === 1) {
          await firstGate;
          return fulfill(route, operationsFixture(false, "old_response"));
        }
        return fulfill(route, operationsFixture(repaired));
      }
      case "/api/admin/discord/reservations/reconcile": {
        repairRequests.push(route.request().postDataJSON() as Record<string, unknown>);
        if (options.conflict) return fulfill(route, { error: { message: "Discord 복구 충돌: stale_state" } }, 409);
        repaired = true;
        return fulfill(route, { result: { auditActionId: "audit-new", kind: "repaired" } });
      }
      case "/api/admin/reservations": return fulfill(route, pageOf(url.searchParams.has("reservationId") ? [reservation] : []));
      case "/api/admin/users": return fulfill(route, pageOf(url.searchParams.has("userId") ? [student] : []));
      case "/api/admin/users/user-1": return fulfill(route, userDetail);
      case "/api/admin/actions": return fulfill(route, pageOf(url.searchParams.get("actionId") === "audit-1" ? [auditAction] : []));
      default: return fulfill(route, { error: { message: `Unexpected ${url.pathname}` } }, 404);
    }
  });
  return { errors, get dashboardReads() { return dashboardReads; }, releaseFirstOperations: releaseFirst, repairRequests };
}

function operationsFixture(repaired: boolean, failureCode = "discord_http_500") {
  return {
    backlogs: {
      initialSends: { count: 1, items: [initialSend], oldestAgeMs: 3_600_000 },
      interactions: { count: repaired ? 1 : 2, items: repaired ? [abandoned] : [retryInteraction, abandoned], oldestAgeMs: 7_200_000 },
      syncs: { count: 1, items: [syncLag], oldestAgeMs: 1_800_000 }
    },
    control: { enabled: true, epoch: 7, pendingRemoteCleanup: false },
    generatedAt: "2026-08-13T00:00:00.000Z",
    jobs: [job("CLOSED_PERIOD_NOTIFICATIONS", "healthy", "ok", null, "SUCCEEDED"), job("DISCORD_INTERACTIONS", "stale", "degraded", failureCode, "FAILED", repaired ? 0 : 1), job("DISCORD_RESERVATION_OUTBOX", "running_timeout", "degraded", "job_timeout", "RUNNING", 1)]
  };
}

function job(name: string, code: string, health: string, failureCode: string | null, status: string, backlogCount = 0) {
  return { backlogCount, failureCode, health: { code, status: health }, job: name, lastAttemptAt: "2026-08-12T23:50:00.000Z", lastSuccessAt: "2026-08-12T23:40:00.000Z", status };
}

const common = { createdAt: "2026-08-12T22:00:00.000Z", expectedControlEpoch: 7, latestAuditActionId: "audit-1", reservationId: "reservation-1", updatedAt: "2026-08-12T23:00:00.000Z", userId: "user-1" };
const initialSend = { ...common, attempts: 2, expectedState: "PENDING_REVIEW", id: "initial-review", kind: "initial_send", permittedActions: ["verify_remote", "abandon"], remoteVerificationStatus: "ZERO_COMPLETE", status: "PENDING_REVIEW" };
const retryInteraction = { ...common, attempts: 3, errorCode: "discord_http_500", expectedState: "RETRY", id: "interaction-retry", kind: "interaction", permittedActions: ["retry"], status: "RETRY" };
const abandoned = { ...common, attempts: 8, errorCode: "attempts_exhausted", expectedState: "ABANDONED", id: "interaction-abandoned", kind: "interaction", latestAuditActionId: null, permittedActions: [], status: "ABANDONED" };
const syncLag = { ...common, expectedState: "RETRY:2:1:7", id: "sync-lag", kind: "sync", messageRevision: 2, permittedActions: ["sync", "remove_controls"], status: "RETRY", syncedRevision: 1 };
const adminUser = { bookingStatus: "ACTIVE", generation: 0, id: "admin-1", name: "관리자", restrictedUntil: null, restrictionReason: null, role: "ADMIN", studentNumber: "0" };
const student = { bookingStatus: "ACTIVE", generation: 1, id: "user-1", name: "운영학생", restrictedUntil: null, restrictionReason: null, role: "STUDENT", shadowBanProfile: "NORMAL", studentNumber: "31001" };
const reservation = { createdAt: "2026-08-12T22:00:00.000Z", date: "2026-08-13", id: "reservation-1", reason: "운영 복구", status: "CANCELLED", studyPeriod: "EIGHTH", user: { bookingStatus: "ACTIVE", id: "user-1", name: "운영학생", role: "STUDENT", studentNumber: "31001" } };
const auditAction = { action: "DISCORD_REPAIR", actor: null, actorId: "admin-1", after: null, before: null, category: "NOTIFICATION", createdAt: "2026-08-13T00:00:00.000Z", id: "audit-1", reason: "운영 복구", reservationId: "reservation-1", targetUser: null, targetUserId: "user-1" };
const periods = [{ capacity: 10, closeTime: "16:20", confirmedCount: 0, date: "2026-08-13", enabled: true, label: "8면학", openTime: "13:00", remaining: 10, studyPeriod: "EIGHTH", windowState: "closed" }, { capacity: 10, closeTime: "17:20", confirmedCount: 0, date: "2026-08-13", enabled: true, label: "1면학", openTime: "14:00", remaining: 10, studyPeriod: "FIRST", windowState: "closed" }];
const dashboardPeriods = periods.map((period) => ({ ...period, applicants: [], isClosed: true, notification: null }));
const notificationSettings = { closedPeriodNotificationsEnabled: true, id: "global", reservationCreatedNotificationsEnabled: false };
const statistics = { dailyStats: [], from: "2026-08-13", periodStats: [], repeatedOffenders: [], to: "2026-08-13", totals: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0, totalCount: 0, uniqueStudentCount: 0 } };
const userDetail = { adminActions: [], auditLogs: [], currentReservations: [], reservationHistory: [], sanctions: [], sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 }, sessionSummary: { activeCount: 0, expiredCount: 0, totalCount: 0 }, summary: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0 }, user: { ...student, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" } };

function pageOf(items: readonly unknown[]) { return { cutoff: "2026-08-13T00:00:00.000Z", currentTotalCount: items.length, expiresAt: "2026-08-13T00:15:00.000Z", items, nextCursor: null }; }
async function fulfill(route: Route, json: unknown, status = 200): Promise<void> { await route.fulfill({ contentType: "application/json", json, status }); }
async function horizontalOverflow(page: Page): Promise<boolean> { return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth); }
function requiredEvidenceDir(): string { const value = process.env.EVIDENCE_DIR; if (!value) throw new Error("EVIDENCE_DIR is required."); return value; }
