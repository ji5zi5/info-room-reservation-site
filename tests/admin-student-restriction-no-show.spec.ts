import { expect, test, type Page, type Route } from "@playwright/test";

import { FIXED_FRIDAY_DATE } from "./e2e-time";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const MOCK_ADMIN_USER = {
  bookingStatus: "ACTIVE",
  generation: 0,
  id: "mock-admin",
  name: "관리자",
  restrictedUntil: null,
  restrictionReason: null,
  role: "ADMIN",
  studentNumber: "0"
} as const;

type MockStudentUser = {
  readonly bookingStatus: "ACTIVE";
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictedUntil: null;
  readonly restrictionReason: null;
  readonly role: "STUDENT";
  readonly studentNumber: string;
};

type MutationTracker = {
  noShowPath: string | null;
  restrictionPayload: unknown;
};

test("admin student detail uses direct restriction reason and current reservation no-show flow", async ({ page }) => {
  const tracker: MutationTracker = { noShowPath: null, restrictionPayload: null };
  await mockAdminStudentDetail(page, tracker);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();

  await page.getByRole("button", { name: "학생" }).click();
  const studentRow = page.locator(".user-line").filter({ hasText: "25-39000" }).first();
  await expect(studentRow).toBeVisible();
  await studentRow.getByRole("button", { name: "상세 보기" }).click();

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await expect(detail).toBeVisible();
  const reasonInput = detail.getByLabel("제재 사유");
  await expect(reasonInput).toHaveValue("");
  await expect(detail.getByLabel("사유 선택")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "예약 취소" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "미출석" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "관리자 확인" })).toHaveCount(0);

  await detail.getByRole("button", { name: "노쇼" }).click();
  await expect.poll(() => tracker.noShowPath).toBe("/api/admin/reservations/mock-user-reservation-1/no-show");
  await reasonInput.fill("직접 입력 사유");
  await expect(reasonInput).toHaveValue("직접 입력 사유");

  const duration = detail.getByRole("group", { name: "제재 기간" });
  await duration.getByRole("button", { name: "영구" }).click();
  await expect(duration.getByRole("button", { name: "영구" })).toHaveAttribute("data-active", "true");
  await detail.getByRole("button", { name: "학생 제재 적용" }).click();
  await expect.poll(() => tracker.restrictionPayload).toEqual({
    days: null,
    reason: "직접 입력 사유",
    status: "BANNED"
  });
});

async function mockAdminStudentDetail(
  page: Page,
  tracker: MutationTracker
): Promise<void> {
  const now = "2026-06-12T12:00:00.000Z";
  const selectedUser: MockStudentUser = {
    bookingStatus: "ACTIVE",
    generation: 25,
    id: "mock-mobile-student-0",
    name: "모바일학생",
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    studentNumber: "25-39000"
  };

  await page.route("**/api/me", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: MOCK_ADMIN_USER } });
  });
  await page.route("**/api/csrf", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { csrfToken: "test-csrf-token" } });
  });
  await page.route("**/api/admin/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/admin/reservations/mock-user-reservation-1/no-show") {
      tracker.noShowPath = pathname;
      await route.fulfill({ contentType: "application/json", json: { reservation: null } });
      return;
    }
    if (pathname === `/api/admin/users/${selectedUser.id}/restriction`) {
      tracker.restrictionPayload = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ contentType: "application/json", json: { user: null } });
      return;
    }
    await fulfillAdminReadRoute(route, selectedUser, now);
  });
}

async function fulfillAdminReadRoute(
  route: Route,
  selectedUser: MockStudentUser,
  now: string
): Promise<void> {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/admin/period-settings") {
    await route.fulfill({ contentType: "application/json", json: { periods: mockAdminPeriods() } });
    return;
  }
  if (pathname === "/api/admin/dashboard") {
    await route.fulfill({
      contentType: "application/json",
      json: { periods: mockAdminPeriods().map((period) => ({ ...period, applicants: [], isClosed: false, notification: null })) }
    });
    return;
  }
  if (pathname === "/api/admin/reservations") {
    await route.fulfill({ contentType: "application/json", json: { reservations: [] } });
    return;
  }
  if (pathname === "/api/admin/statistics") {
    await route.fulfill({ contentType: "application/json", json: { statistics: mockAdminStatistics() } });
    return;
  }
  if (pathname === "/api/admin/users") {
    await route.fulfill({ contentType: "application/json", json: { users: [selectedUser] } });
    return;
  }
  if (pathname === `/api/admin/users/${selectedUser.id}`) {
    await route.fulfill({ contentType: "application/json", json: mockAdminUserDetail(selectedUser, now) });
    return;
  }
  if (pathname === "/api/admin/actions") {
    await route.fulfill({ contentType: "application/json", json: { actions: [] } });
    return;
  }
  await route.fulfill({ contentType: "application/json", json: { error: { message: "Unexpected mocked admin route" } }, status: 404 });
}

function mockAdminPeriods() {
  return [
    {
      capacity: 10,
      closeTime: "21:00",
      confirmedCount: 0,
      date: FIXED_FRIDAY_DATE,
      enabled: true,
      label: "8면학",
      openTime: "20:00",
      remaining: 10,
      studyPeriod: "EIGHTH",
      windowState: "not_open_yet"
    },
    {
      capacity: 10,
      closeTime: "22:00",
      confirmedCount: 0,
      date: FIXED_FRIDAY_DATE,
      enabled: true,
      label: "1면학",
      openTime: "21:00",
      remaining: 10,
      studyPeriod: "FIRST",
      windowState: "not_open_yet"
    }
  ];
}

function mockAdminStatistics() {
  return {
    dailyStats: [],
    from: FIXED_FRIDAY_DATE,
    periodStats: [],
    repeatedOffenders: [],
    to: FIXED_FRIDAY_DATE,
    totals: { cancelledCount: 0, confirmedCount: 0, noShowCount: 0, totalCount: 0, uniqueStudentCount: 1 }
  };
}

function mockAdminUserDetail(selectedUser: MockStudentUser, now: string) {
  return {
    adminActions: [],
    auditLogs: [],
    currentReservations: [mockUserReservation(0, selectedUser.id, "NO_SHOW", now), mockUserReservation(1, selectedUser.id, "CONFIRMED", now)],
    reservationHistory: [mockUserReservation(2, selectedUser.id, "CANCELLED", now)],
    sanctions: [],
    sanctionSummary: { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 },
    sessionSummary: { activeCount: 0, expiredCount: 0, totalCount: 0 },
    summary: { cancelledCount: 1, confirmedCount: 1, noShowCount: 1 },
    user: { ...selectedUser, createdAt: now, updatedAt: now }
  };
}

function mockUserReservation(index: number, userId: string, status: "CANCELLED" | "CONFIRMED" | "NO_SHOW", now: string) {
  return {
    createdAt: now,
    date: FIXED_FRIDAY_DATE,
    id: `mock-user-reservation-${index}`,
    reason: "테스트",
    status,
    studyPeriod: index % 2 === 0 ? "EIGHTH" : "FIRST",
    updatedAt: now,
    userId
  };
}
