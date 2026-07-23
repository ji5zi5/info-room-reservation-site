import { expect, test, type Locator, type Page } from "@playwright/test";

import { e2eNow, FIXED_FRIDAY_DATE, mockClientDate, mockOpenPeriodsForDates } from "./e2e-time";
import { csrfRequest } from "./playwright-csrf";
import { visibleBox } from "./playwright-layout";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const ADMIN_LOGIN_ALIAS = "admin";
const CAN_USE_LOCAL_LOGIN_ENV = isLocalE2eTarget(BASE_URL) || process.env.E2E_ALLOW_LOCAL_LOGIN_ENV === "true";
const ADMIN_LOGIN_ID = requiredAdminCredential("E2E_ADMIN_LOGIN_ID", "ADMIN_LOGIN_ID", ADMIN_LOGIN_ALIAS);
const ADMIN_LOGIN_PASSWORD = requiredAdminCredential("E2E_ADMIN_LOGIN_PASSWORD", "ADMIN_LOGIN_PASSWORD", "password");
const LOCAL_STUDENT_LOGIN_ID = process.env.E2E_STUDENT_LOGIN_ID ?? localOnlyEnv("LOCAL_STUDENT_LOGIN_ID");
const LOCAL_STUDENT_NUMBER = process.env.E2E_STUDENT_NUMBER ?? localOnlyEnv("LOCAL_STUDENT_NUMBER") ?? LOCAL_STUDENT_LOGIN_ID;
const STUDENT_LOGIN_PASSWORD = process.env.E2E_STUDENT_LOGIN_PASSWORD ?? localOnlyEnv("LOCAL_STUDENT_LOGIN_PASSWORD") ?? "password";
const TEST_IP_RUN_OCTET = (Date.now() % 200) + 1;
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
let testIpCounter = 0;

async function login(page: Page, loginId: string, fixedIso = e2eNow()): Promise<void> {
  if (loginId === ADMIN_LOGIN_ALIAS) {
    await loginWithApi(page, loginId, fixedIso);
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
    return;
  }
  await loginWithApi(page, loginId, fixedIso);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.locator(".period-card .period-badge").first().waitFor();
}

async function logout(page: Page): Promise<void> {
  await csrfRequest(page, "/api/auth/logout", { method: "POST" });
}

async function loginWithApi(page: Page, loginId: string, fixedIso = e2eNow()): Promise<void> {
  await mockClientDate(page, fixedIso);
  const credentials =
    loginId === ADMIN_LOGIN_ALIAS
      ? { id: ADMIN_LOGIN_ID, password: ADMIN_LOGIN_PASSWORD }
      : studentCredentials(loginId);
  const response = await page.request.post(`${BASE_URL}/api/auth/riro/login`, {
    data: credentials,
    headers: { "x-forwarded-for": nextTestIp() }
  });
  if (!response.ok()) {
    throw new Error(`Login failed with ${response.status()}: ${await response.text()}`);
  }
}

function nextTestIp(): string {
  testIpCounter += 1;
  return `198.51.${TEST_IP_RUN_OCTET}.${(testIpCounter % 250) + 1}`;
}

function studentCredentials(loginId: string): { readonly id: string; readonly password: string } {
  if (LOCAL_STUDENT_LOGIN_ID) {
    return { id: LOCAL_STUDENT_LOGIN_ID, password: STUDENT_LOGIN_PASSWORD };
  }
  return { id: loginId, password: STUDENT_LOGIN_PASSWORD };
}

function expectedStudentNumber(loginId: string): string {
  if (LOCAL_STUDENT_NUMBER) {
    return LOCAL_STUDENT_NUMBER;
  }
  const digits = loginId.replace(/\D/gu, "");
  return digits.length >= 4 ? digits.slice(-5) : `9${digits.padStart(4, "0")}`;
}

function localOnlyEnv(name: string): string | undefined {
  return CAN_USE_LOCAL_LOGIN_ENV ? process.env[name] : undefined;
}

function requiredAdminCredential(e2eName: string, localName: string, localDefault: string): string {
  const e2eValue = process.env[e2eName];
  if (e2eValue) {
    return e2eValue;
  }
  if (CAN_USE_LOCAL_LOGIN_ENV) {
    return process.env[localName] ?? localDefault;
  }
  throw new Error(`${e2eName} is required for non-local E2E targets.`);
}

function isLocalE2eTarget(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

async function mockAdminStudentManagement(page: Page, selectedStudentNumber: string): Promise<void> {
  const now = "2026-06-12T12:00:00.000Z";
  const users = Array.from({ length: 40 }, (_, index) => ({
    bookingStatus: "ACTIVE",
    generation: 25,
    id: `mock-mobile-student-${index}`,
    name: index === 0 ? "모바일학생" : `학생${String(index + 1).padStart(2, "0")}`,
    restrictedUntil: null,
    restrictionReason: null,
    role: "STUDENT",
    studentNumber: index === 0 ? selectedStudentNumber : `25-${String(39000 + index).padStart(5, "0")}`
  }));
  const selectedUser = users[0];
  if (!selectedUser) {
    throw new Error("Expected at least one mocked admin user.");
  }

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { user: MOCK_ADMIN_USER }
    });
  });
  await page.route("**/api/auth/riro/login", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { user: MOCK_ADMIN_USER } });
  });

  await page.route("**/api/admin/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/admin/period-settings") {
      await route.fulfill({ contentType: "application/json", json: { periods: mockAdminPeriods() } });
      return;
    }
    if (pathname === "/api/admin/notification-settings") {
      await route.fulfill({ contentType: "application/json", json: { notificationSettings: mockNotificationSettings() } });
      return;
    }
    if (pathname === "/api/admin/dashboard") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          notificationBacklog: [],
          periods: mockAdminPeriods().map((period) => ({
            ...period,
            applicants: [],
            isClosed: false,
            notification: null
          }))
        }
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
      await route.fulfill({ contentType: "application/json", json: { users } });
      return;
    }
    if (pathname === `/api/admin/users/${selectedUser.id}`) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          adminActions: Array.from({ length: 8 }, (_, index) => mockAdminAction(index, selectedUser.id, now)),
          auditLogs: Array.from({ length: 8 }, (_, index) => ({
            action: "USER_DETAIL_VIEWED",
            actorId: "mock-admin",
            createdAt: now,
            detail: `학생 상세 확인 ${index + 1}`,
            id: `mock-audit-log-${index}`
          })),
          currentReservations: Array.from({ length: 2 }, (_, index) => mockUserReservation(index, selectedUser.id, now)),
          reservationHistory: Array.from({ length: 18 }, (_, index) =>
            mockUserReservation(index + 2, selectedUser.id, now)
          ),
          sanctions: Array.from({ length: 8 }, (_, index) => ({
            actorId: "mock-admin",
            createdAt: now,
            endsAt: null,
            id: `mock-sanction-${index}`,
            reason: `모바일 상세 스크롤 확인 ${index + 1}`,
            revokedAt: null,
            revokedById: null,
            revokedReason: null,
            sourceActionId: null,
            startsAt: now,
            status: index === 0 ? "ACTIVE" : "REVOKED",
            type: index === 0 ? "BANNED" : "RESTRICTED"
          })),
          sanctionSummary: { activeCount: 1, permanentCount: 1, revokedCount: 7, totalCount: 8 },
          sessionSummary: { activeCount: 1, expiredCount: 3, totalCount: 4 },
          summary: { cancelledCount: 3, confirmedCount: 12, noShowCount: 2 },
          user: {
            ...selectedUser,
            createdAt: now,
            updatedAt: now
          }
        }
      });
      return;
    }
    if (pathname === "/api/admin/actions") {
      await route.fulfill({ contentType: "application/json", json: { actions: [] } });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { error: { message: "Unexpected mocked admin route" } }, status: 404 });
  });
}

async function openMockedAdminConsole(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const adminHeading = page.getByRole("heading", { name: "관리자" });
  const loginButton = page.getByRole("button", { name: "인증하기" });
  await expect(adminHeading.or(loginButton)).toBeVisible();
  if (await adminHeading.isVisible()) {
    return;
  }
  await page.getByLabel("리로스쿨 ID").fill("admin");
  await page.getByLabel("리로스쿨 PW").fill("password");
  await loginButton.click();
  await expect(adminHeading).toBeVisible();
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

function mockNotificationSettings() {
  return {
    closedPeriodNotificationsEnabled: true,
    id: "global",
    reservationCreatedNotificationsEnabled: false
  };
}

function mockAdminStatistics() {
  return {
    dailyStats: [],
    from: FIXED_FRIDAY_DATE,
    periodStats: [],
    repeatedOffenders: [],
    to: FIXED_FRIDAY_DATE,
    totals: {
      cancelledCount: 0,
      confirmedCount: 0,
      noShowCount: 0,
      totalCount: 0,
      uniqueStudentCount: 40
    }
  };
}

function mockAdminAction(index: number, targetUserId: string, now: string) {
  return {
    action: "USER_RESTRICTION_UPDATED",
    actorId: "mock-admin",
    after: null,
    before: null,
    createdAt: now,
    id: `mock-action-${index}`,
    reason: `모바일 상세 기록 ${index + 1}`,
    reservationId: null,
    targetUserId
  };
}

function mockUserReservation(index: number, userId: string, now: string) {
  return {
    createdAt: now,
    date: FIXED_FRIDAY_DATE,
    id: `mock-user-reservation-${index}`,
    reason: "테스트",
    status: index % 5 === 0 ? "NO_SHOW" : index % 3 === 0 ? "CANCELLED" : "CONFIRMED",
    studyPeriod: index % 2 === 0 ? "EIGHTH" : "FIRST",
    updatedAt: now,
    userId
  };
}

test("admin student management keeps empty detail from clipping the 390px viewport", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await login(page, "admin");
  await page.getByRole("button", { name: "학생" }).click();
  await expect(page.getByRole("heading", { name: "학생 관리" })).toBeVisible();

  await expect(page.locator(".student-detail-panel")).toHaveCount(0);
  const metrics = await page.evaluate(() => ({
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth
  }));
  expect(metrics.rootScrollWidth, "student admin view should not have horizontal clipping").toBeLessThanOrEqual(metrics.rootClientWidth);
});

test("mobile admin navigation stays compact above the workspace", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await mockAdminStudentManagement(page, "25-39000");
  await openMockedAdminConsole(page);

  const nav = page.locator(".admin-nav-panel");
  const sectionNav = page.locator(".admin-section-nav");
  const dashboardTopbar = page.locator(".admin-dashboard-topbar");
  await expect(page.getByRole("heading", { name: "관리자" })).toBeVisible();
  const navBox = await visibleBox(nav, "mobile admin navigation");
  const sectionNavBox = await visibleBox(sectionNav, "mobile admin section navigation");
  const dashboardTopbarBox = await visibleBox(dashboardTopbar, "mobile dashboard topbar");
  const dashboardHeadingBox = await visibleBox(page.getByRole("heading", { name: "운영 대시보드" }), "dashboard title");
  const dashboardActionBox = await visibleBox(
    dashboardTopbar.getByRole("button", { name: "통계 복사" }),
    "dashboard copy action"
  );
  const dashboardHeadingCenterY = dashboardHeadingBox.y + dashboardHeadingBox.height / 2;
  const dashboardActionCenterY = dashboardActionBox.y + dashboardActionBox.height / 2;
  const buttonRows = await sectionNav.locator("button").evaluateAll((buttons) =>
    [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)))]
  );
  const metrics = await page.evaluate(() => ({
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth
  }));

  await expect(sectionNav.locator("button")).toHaveCount(6);
  await expect(sectionNav.getByRole("button", { name: "블랙" })).toBeVisible();
  expect(sectionNavBox.height, "admin menu should fit in one compact row").toBeLessThanOrEqual(44);
  expect(buttonRows, "admin menu buttons should not wrap into extra rows").toHaveLength(1);
  expect(navBox.height, "admin navigation should leave room for the workspace").toBeLessThanOrEqual(190);
  expect(dashboardTopbarBox.height, "dashboard actions should not create a tall icon-only row").toBeLessThanOrEqual(48);
  expect(Math.abs(Math.round(dashboardHeadingCenterY - dashboardActionCenterY))).toBeLessThanOrEqual(4);
  expect(metrics.rootScrollWidth, "compact admin nav should not create horizontal clipping").toBeLessThanOrEqual(
    metrics.rootClientWidth
  );
});

test("admin E2E credential guard treats only loopback targets as local", () => {
  expect(isLocalE2eTarget("http://localhost:3000")).toBe(true);
  expect(isLocalE2eTarget("http://127.0.0.1:3000")).toBe(true);
  expect(isLocalE2eTarget("http://[::1]:3000")).toBe(true);
  expect(isLocalE2eTarget("https://reservation.example.com")).toBe(false);
});

test("admin compact indicators use the design radius", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await login(page, "admin");

  await expectBorderRadius(page.locator(".notification-pill").first(), "admin notification pill", "4px");
  await page.getByRole("button", { name: "학생" }).click();
  await expectBorderRadius(page.locator(".status-chip").first(), "admin status chip", "4px");
});

test("admin panels keep concise headings and open student detail space only when selected", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await login(page, "admin");

  await expect(page.getByText("현황 · 명단 · 학생 제재 · 설정")).toHaveCount(0);
  await expect(page.getByText("신청 현황 · 마감 상태 · Discord 발송")).toHaveCount(0);
  await expect(page.locator(".student-detail-panel")).toHaveCount(0);
  await expect(page.locator(".admin-workspace")).toHaveAttribute("data-detail", "closed");
  const dashboardTracks = await page
    .locator(".admin-workspace")
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length);
  expect(dashboardTracks).toBe(1);

  await page.getByRole("button", { name: "예약자" }).click();
  await expect(page.getByText("검색 · 노쇼 · 관리자 취소 · 명단 복사")).toHaveCount(0);
  await expect(page.locator(".student-detail-panel")).toHaveCount(0);

  await page.getByRole("button", { name: "블랙" }).click();
  await expect(page.getByText("블랙리스트 유저는 예약 시 랜덤 서버 에러가 발생")).toHaveCount(0);
  await expect(page.getByText("이름이나 학번을 검색하면 아래에 결과가 표시됩니다.")).toHaveCount(0);

  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByText("시간 설정 · 운영 현황 · 학생 관리")).toHaveCount(0);
  await expect(page.getByLabel("예약 날짜")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(1);
  await expect(page.getByLabel("운영 날짜")).toBeVisible();
});

test("friday advance unavailable keeps the same content rail as today tab", async ({ page }) => {
  await mockOpenPeriodsForDates(page, FIXED_FRIDAY_DATE);
  await login(page, `friday-rail-${Date.now()}`, e2eNow(FIXED_FRIDAY_DATE));

  const todayCard = page.locator(".period-card").first();
  const todayBox = await visibleBox(todayCard, "today period card");
  await page.getByRole("button", { name: "사전예약" }).click();

  const unavailable = page.getByRole("status").filter({ hasText: "사전예약 불가" });
  await expect(unavailable).toBeVisible();
  const unavailableBox = await visibleBox(unavailable, "advance unavailable panel");
  expect(Math.abs(Math.round(unavailableBox.y - todayBox.y))).toBeLessThanOrEqual(2);
});

test("left panel exposes smooth width and content transitions", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await login(page, `motion-${Date.now()}`);

  const panel = page.locator(".login-panel");
  const content = page.locator(".sidebar-content");
  const openBox = await visibleBox(panel, "open sidebar");
  await page.getByRole("button", { name: "내 정보 패널 접기" }).click();
  await expect(page.getByRole("button", { name: "내 정보 패널 열기" })).toBeVisible();

  const closedDisplay = await content.evaluate((element) => getComputedStyle(element).display);
  const closedTransition = await content.evaluate((element) => getComputedStyle(element).transitionProperty);
  await expect.poll(async () => Math.round((await visibleBox(panel, "closed sidebar")).width)).toBe(72);
  const closedBox = await visibleBox(panel, "closed sidebar");
  const toggleBox = await visibleBox(page.getByRole("button", { name: "내 정보 패널 열기" }), "closed sidebar toggle");

  expect(closedBox.height, "closing should keep a stable panel surface").toBeGreaterThan(70);
  expect(closedBox.y).toBe(openBox.y);
  expect(Math.round(closedBox.width)).toBe(72);
  expect(Math.abs(Math.round(toggleBox.x + toggleBox.width / 2 - (closedBox.x + closedBox.width / 2)))).toBeLessThanOrEqual(1);
  expect(closedDisplay, "sidebar content must remain renderable so opacity/transform can animate").not.toBe("none");
  expect(closedTransition).toContain("opacity");
  expect(closedTransition).toContain("transform");
});

test("mobile left panel collapses to a reopen button and expands again", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await login(page, `mobile-fold-${Date.now()}`);

  await page.getByRole("button", { name: "내 정보 패널 열기" }).click();
  await page.getByRole("button", { name: "내 정보 패널 접기" }).click();
  await expect.poll(async () => Math.round((await visibleBox(page.locator(".login-panel"), "closed mobile panel")).height)).toBeLessThanOrEqual(80);

  await page.getByRole("button", { name: "내 정보 패널 열기" }).click();
  await expect(page.getByRole("button", { name: "내 정보 패널 접기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "정보실 예약" })).toBeVisible();
});

test("mobile admin student detail flows below the list without clipping", async ({ page }) => {
  const studentNumber = "25-39000";
  await page.setViewportSize({ height: 900, width: 390 });
  await mockAdminStudentManagement(page, studentNumber);
  await openMockedAdminConsole(page);
  await page.getByRole("button", { name: "학생" }).click();
  const studentRow = page.locator(".user-line").filter({ hasText: studentNumber }).first();
  await expect(studentRow).toBeVisible();
  await studentRow.getByRole("button", { name: "상세 보기" }).click();

  const detail = page.locator(".student-detail-panel[data-open='true']");
  await expect(detail).toBeVisible();
  const closeButton = detail.getByRole("button", { name: "학생 상세 닫기" });
  await expect(closeButton.locator("svg")).toHaveCount(1);
  await expect(closeButton).not.toHaveText("×");
  await expect(detail.getByRole("button", { name: "로그아웃 처리" })).toHaveCount(0);
  const metrics = await page.evaluate(() => {
    const detailElement = document.querySelector(".student-detail-panel[data-open='true']");
    const actions = document.querySelector(".student-detail-panel[data-open='true'] .detail-actions");
    const metricRow = document.querySelector(".student-detail-panel[data-open='true'] .detail-metrics");
    const userList = document.querySelector(".user-list");
    const mainPanel = document.querySelector(".admin-main-panel");
    return {
      actionsColumns: actions ? getComputedStyle(actions).gridTemplateColumns.split(" ").length : 0,
      detailClientHeight: detailElement?.clientHeight ?? 0,
      detailOverflowY: detailElement ? getComputedStyle(detailElement).overflowY : null,
      detailScrollHeight: detailElement?.scrollHeight ?? 0,
      detailTop: detailElement?.getBoundingClientRect().top ?? 0,
      listClientHeight: userList?.clientHeight ?? 0,
      listOverflowY: userList ? getComputedStyle(userList).overflowY : null,
      listScrollHeight: userList?.scrollHeight ?? 0,
      mainPanelBottom: mainPanel?.getBoundingClientRect().bottom ?? 0,
      metricsColumns: metricRow ? getComputedStyle(metricRow).gridTemplateColumns.split(" ").length : 0,
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight
    };
  });

  expect(metrics.rootScrollWidth, "admin student detail should not create horizontal clipping").toBeLessThanOrEqual(metrics.rootClientWidth);
  expect(metrics.metricsColumns).toBe(2);
  expect(metrics.actionsColumns).toBe(0);
  expect(metrics.listOverflowY, "student list should be ready to scroll internally on mobile").toBe("auto");
  expect(metrics.listClientHeight, "student list should not monopolize mobile page height").toBeLessThanOrEqual(
    Math.ceil(metrics.viewportHeight * 0.48)
  );
  expect(metrics.listScrollHeight, "long student list should scroll inside its panel").toBeGreaterThan(metrics.listClientHeight);
  expect(metrics.detailOverflowY, "student detail should stay bounded on mobile").toBe("auto");
  expect(metrics.detailClientHeight, "student detail should not become a full-page tail on mobile").toBeLessThanOrEqual(
    Math.ceil(metrics.viewportHeight * 0.7)
  );
  expect(metrics.detailScrollHeight, "long student detail should scroll inside its panel").toBeGreaterThan(
    metrics.detailClientHeight
  );
  expect(metrics.detailTop, "student detail should sit below the student list on mobile").toBeGreaterThanOrEqual(
    metrics.mainPanelBottom - 1
  );
});

test("admin setting toggles keep visible checkbox targets comfortable", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await mockAdminStudentManagement(page, "25-39000");
  await openMockedAdminConsole(page);

  await page.getByRole("button", { name: "설정" }).click();

  const checkboxMetrics = await page.locator(".admin-console-layout input[type='checkbox']").evaluateAll((inputs) =>
    inputs.map((input) => {
      const box = input.getBoundingClientRect();
      return { height: box.height, width: box.width };
    })
  );

  expect(checkboxMetrics.length).toBeGreaterThanOrEqual(4);
  for (const metric of checkboxMetrics) {
    expect(metric.width).toBeGreaterThanOrEqual(20);
    expect(metric.height).toBeGreaterThanOrEqual(20);
  }
});

async function expectBorderRadius(locator: Locator, label: string, expectedRadius: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const radius = await locator.evaluate((element) => {
    const view = element.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("document view should exist");
    }
    return view.getComputedStyle(element).borderRadius;
  });
  expect.soft(radius, `${label} border radius`).toBe(expectedRadius);
}
