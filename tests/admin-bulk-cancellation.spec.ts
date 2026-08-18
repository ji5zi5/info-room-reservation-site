import { expect, test, type Page, type Route } from "@playwright/test";
import { join } from "node:path";
import { z } from "zod";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

test("bulk cancellation previews server truth, restores focus on cancel, and retains only retryable partial failures", async ({ page }) => {
  const fixture = await mockAdminConsole(page, fourReservations());
  await page.setViewportSize({ height: 900, width: 1440 });
  await openReservations(page);

  const checkboxes = page.locator('.admin-reservation-line input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    await checkboxes.nth(index).check();
  }
  await expect(page.getByText("4건 선택", { exact: true })).toBeVisible();

  const bulkButton = page.getByRole("button", { name: "선택 취소" });
  await bulkButton.click();
  const reason = page.getByRole("dialog", { name: "일괄 취소 미리보기" }).getByLabel("취소 사유");
  await expect(reason).toBeFocused();
  await reason.fill("운영 일정 변경");
  expect(fixture.previewAttempts).toBe(0);

  await page.getByRole("button", { name: "서버 미리보기" }).click();
  const previewDialog = page.getByRole("dialog", { name: "일괄 취소 미리보기" });
  await expect(previewDialog.getByRole("alert")).toContainText("네트워크 연결");
  await expect(previewDialog).toBeVisible();
  await page.getByRole("button", { name: "서버 미리보기" }).click();

  const confirmation = page.getByRole("dialog", { name: "선택 예약을 취소할까요?" });
  await expect(confirmation).toContainText("취소 가능 2건");
  await expect(confirmation).toContainText("상태 변경 1건");
  await expect(confirmation).toContainText("찾을 수 없음 1건");
  await expect(confirmation).toContainText("변경학생");
  await expect(confirmation).toContainText("누락학생");
  await expect(confirmation.getByRole("button", { name: "일괄 취소 확정" })).toBeEnabled();
  expect(fixture.executeAttempts).toBe(0);
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-17-admin-bulk-cancellation-desktop-1440x900.png") });

  await confirmation.getByRole("button", { name: "돌아가기" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(bulkButton).toBeFocused();
  await expect(page.getByText("4건 선택", { exact: true })).toBeVisible();

  await bulkButton.click();
  await page.getByRole("dialog", { name: "일괄 취소 미리보기" }).getByLabel("취소 사유").fill("운영 일정 변경");
  await page.getByRole("button", { name: "서버 미리보기" }).click();
  await page.getByRole("button", { name: "일괄 취소 확정" }).click();

  await expect.poll(() => fixture.executeAttempts).toBe(1);
  const resultDialog = page.getByRole("dialog", { name: "일괄 취소 결과" });
  await expect(resultDialog).toContainText("취소학생");
  await expect(resultDialog).toContainText("취소 완료");
  await expect(resultDialog).toContainText("변경학생");
  await expect(resultDialog).toContainText("상태 변경");
  await expect(resultDialog).toContainText("누락학생");
  await expect(resultDialog).toContainText("찾을 수 없음");
  await expect(resultDialog).toContainText("재시도학생");
  await expect(resultDialog).toContainText("재시도 필요");
  await expect(page.getByText("4건 처리 결과: 취소 1건, 상태 변경 1건, 찾을 수 없음 1건, 재시도 필요 1건.")).toBeVisible();
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-17-admin-bulk-cancellation-result-desktop-1440x900.png") });
  await resultDialog.getByRole("button", { name: "확인" }).click();
  await expect(resultDialog).toHaveCount(0);
  await expect(bulkButton).toBeFocused();
  await expect(page.getByText("1건 선택", { exact: true })).toBeVisible();
  await expect(checkboxes.nth(3)).toBeChecked();
  await expect(checkboxes.nth(0)).not.toBeChecked();
  await expect(page.locator(".bulk-cancellation-toolbar").getByRole("button", { name: /노쇼|제재/u })).toHaveCount(0);

  fixture.setReservationStatus("reservation-conflict", "CANCELLED");
  await page.getByRole("button", { name: "새로고침" }).click();
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();
  await expect(page.getByLabel("재시도학생 예약 선택")).toHaveCount(0);

  await page.getByLabel("이름 또는 학번").fill("재검색");
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();

  await page.getByLabel("이름 또는 학번").fill("");
  const firstRow = page.locator(".admin-reservation-line").first();
  await firstRow.getByRole("button", { exact: true, name: "취소" }).click();
  await expect(page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" })).toBeVisible();
  await page.getByRole("dialog", { name: "예약을 관리자 취소할까요?" }).locator(".admin-dialog-actions").getByRole("button", { name: "닫기" }).click();
});

test("bulk cancellation toolbar and confirmation stay within a 390px viewport", async ({ page }) => {
  await mockAdminConsole(page, fourReservations(), { failFirstPreview: false });
  await page.setViewportSize({ height: 844, width: 390 });
  await openReservations(page);

  const checkboxes = page.locator('.admin-reservation-line input[type="checkbox"]');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.getByRole("button", { name: "선택 취소" }).click();
  await page.getByRole("dialog", { name: "일괄 취소 미리보기" }).getByLabel("취소 사유").fill("모바일 운영 변경");
  await page.getByRole("button", { name: "서버 미리보기" }).click();

  await expect(page.getByRole("dialog", { name: "선택 예약을 취소할까요?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "일괄 취소 확정" })).toBeEnabled();
  await expect.poll(() => horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: join(requiredEvidenceDir(), "task-17-admin-bulk-cancellation-mobile-390x844.png") });
});

test("bulk selection caps at 50 and clears on date, query, status, and period changes", async ({ page }) => {
  await mockAdminConsole(page, manyReservations(51), { failFirstPreview: false });
  await openReservations(page);

  const checkboxes = page.locator('.admin-reservation-line input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(51);
  for (let index = 0; index < 50; index += 1) {
    await checkboxes.nth(index).check();
  }
  await expect(page.getByText("50건 선택", { exact: true })).toBeVisible();
  await expect(checkboxes.nth(50)).toBeDisabled();

  await page.getByLabel("이름 또는 학번").fill("검색 변경");
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();
  await page.getByLabel("이름 또는 학번").fill("");

  await checkboxes.nth(0).check();
  await page.locator(".admin-row").getByLabel("시간대").selectOption("EIGHTH");
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();

  await checkboxes.nth(0).check();
  await page.locator(".status-filter").getByRole("button", { name: "전체" }).click();
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();

  await checkboxes.nth(0).check();
  await page.getByLabel("운영 날짜").fill("2026-08-14");
  await expect(page.getByText("0건 선택", { exact: true })).toBeVisible();
});

type BulkFixture = {
  executeAttempts: number;
  previewAttempts: number;
  setReservationStatus: (reservationId: string, status: string) => void;
};

async function mockAdminConsole(
  page: Page,
  reservations: readonly object[],
  options: { readonly failFirstPreview?: boolean } = {}
): Promise<BulkFixture> {
  let currentReservations = [...reservations];
  const fixture: BulkFixture = {
    executeAttempts: 0,
    previewAttempts: 0,
    setReservationStatus: (reservationId, status) => {
      currentReservations = currentReservations.map((reservation) => {
        const record = z.object({ id: z.string() }).passthrough().parse(reservation);
        return record.id === reservationId ? { ...record, status } : reservation;
      });
    }
  };
  const failFirstPreview = options.failFirstPreview ?? true;
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: adminUser } }));
  await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "todo-17-csrf" } }));
  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/admin/reservations/bulk-cancel") {
      const body = BulkRequestSchema.safeParse(route.request().postDataJSON());
      if (!body.success) {
        await fulfill(route, { error: { message: "Malformed bulk request" } }, 400);
        return;
      }
      if (body.data.mode === "preview") {
        fixture.previewAttempts += 1;
        if (failFirstPreview && fixture.previewAttempts === 1) {
          await route.abort("failed");
          return;
        }
        await fulfill(route, previewResult(body.data.reservationIds));
        return;
      }
      fixture.executeAttempts += 1;
      await fulfill(route, executeResult(body.data.reservationIds));
      return;
    }
    switch (url.pathname) {
      case "/api/admin/period-settings": return fulfill(route, { periods });
      case "/api/admin/notification-settings": return fulfill(route, { notificationSettings });
      case "/api/admin/dashboard": return fulfill(route, { notificationBacklog: [], periods: [] });
      case "/api/admin/statistics": return fulfill(route, { statistics: null });
      case "/api/admin/operations": return fulfill(route, emptyOperations);
      case "/api/admin/reservations": return fulfill(route, pageOf(currentReservations));
      case "/api/admin/users": return fulfill(route, pageOf([]));
      case "/api/admin/actions": return fulfill(route, pageOf([]));
      default: return fulfill(route, { error: { message: `Unexpected ${url.pathname}` } }, 404);
    }
  });
  return fixture;
}

async function openReservations(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "예약자" }).click();
  await expect(page.getByRole("heading", { name: "예약자 목록" })).toBeVisible();
}

function previewResult(ids: readonly string[]): object {
  const statuses = ids.map((reservationId, index) => ({
    reservationId,
    status: index === 1 ? "invalid_status" : index === 2 ? "not_found" : "cancelled"
  }));
  return resultPayload(statuses);
}

function executeResult(ids: readonly string[]): object {
  const statuses = ids.map((reservationId, index) => ({
    reservationId,
    status: index === 0 ? "cancelled" : index === 1 ? "invalid_status" : index === 2 ? "not_found" : "conflict"
  }));
  return resultPayload(statuses);
}

function resultPayload(results: readonly { readonly reservationId: string; readonly status: string }[]): object {
  return {
    results,
    summary: {
      cancelled: results.filter((item) => item.status === "cancelled").length,
      conflict: results.filter((item) => item.status === "conflict").length,
      invalidStatus: results.filter((item) => item.status === "invalid_status").length,
      notFound: results.filter((item) => item.status === "not_found").length,
      total: results.length
    }
  };
}

function fourReservations(): readonly object[] {
  return [
    reservation("reservation-cancel", "취소학생", "25101"),
    reservation("reservation-changed", "변경학생", "25102"),
    reservation("reservation-missing", "누락학생", "25103"),
    reservation("reservation-conflict", "재시도학생", "25104")
  ];
}

function manyReservations(count: number): readonly object[] {
  return Array.from({ length: count }, (_, index) => (
    reservation(`reservation-${index + 1}`, `선택학생${index + 1}`, `26${String(index + 1).padStart(3, "0")}`)
  ));
}

function reservation(id: string, name: string, studentNumber: string): object {
  return {
    createdAt: "2026-08-13T00:00:00.000Z",
    date: "2026-08-13",
    id,
    reason: "학습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: { bookingStatus: "ACTIVE", id: `user-${id}`, name, role: "STUDENT", studentNumber }
  };
}

function pageOf(items: readonly object[]): object {
  return {
    cutoff: "2026-08-13T00:00:00.000Z",
    currentTotalCount: items.length,
    expiresAt: "2026-08-13T00:15:00.000Z",
    items,
    nextCursor: null
  };
}

const BulkRequestSchema = z.object({
  mode: z.enum(["execute", "preview"]),
  reason: z.string(),
  reservationIds: z.array(z.string())
}).strict();

async function fulfill(route: Route, json: unknown, status = 200): Promise<void> {
  await route.fulfill({ contentType: "application/json", json, status });
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
const periods = [{ capacity: 10, closeTime: "16:20", confirmedCount: 0, date: "2026-08-13", enabled: true, label: "8면학", openTime: "13:00", remaining: 10, studyPeriod: "EIGHTH", windowState: "closed" }];
const notificationSettings = { closedPeriodNotificationsEnabled: true, id: "global", reservationCreatedNotificationsEnabled: false };
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
