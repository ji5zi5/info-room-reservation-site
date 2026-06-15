import { describe, expect, it } from "vitest";

import { buildAuditActionsCsv, buildReservationCsv, buildStatisticsCsv } from "./admin-csv";
import type { AdminAuditAction, AdminReservation, AdminStatistics } from "./admin-types";

describe("admin CSV helpers", () => {
  it("escapes reservation cells", () => {
    expect(buildReservationCsv([reservation({ name: '김"학생', studentNumber: "24101" })])).toContain('"김""학생"');
  });

  it("exports reservation reasons for admin copy lists", () => {
    const csv = buildReservationCsv([
      reservation({ name: "김학생", reason: "프린트, 자료", studentNumber: "24101" })
    ]);

    expect(csv).toContain("날짜,시간대,상태,이름,학번,사유");
    expect(csv).toContain('2026-06-12,8면학,CONFIRMED,김학생,24101,"프린트, 자료"');
  });

  it("exports statistics totals, periods, daily rows, and repeated offenders", () => {
    const csv = buildStatisticsCsv(statistics);

    expect(csv).toContain("구분,날짜,시간대,전체,확정,취소,노쇼,고유학생,정원,채움률,이름,학번");
    expect(csv).toContain("전체,2026-06-12 - 2026-06-12,,3,1,1,1,2,,,,");
    expect(csv).toContain("시간대,,8면학,2,0,1,1,,10,0,,");
    expect(csv).toContain("일자,2026-06-12,,3,1,1,1,,,,,");
    expect(csv).toContain("반복자,,,2,,1,1,,,,박반복,24102");
  });

  it("exports audit actions with actor and target people", () => {
    const csv = buildAuditActionsCsv([
      {
        action: "USER_RESTRICTION_APPLY",
        actor: { id: "admin", name: "관리자", studentNumber: "teacher" },
        actorId: "admin",
        after: null,
        before: null,
        category: "RESTRICTION",
        createdAt: "2026-06-12T04:30:00.000Z",
        id: "action-1",
        reason: "예약 취소, 3일 제한",
        reservationId: null,
        targetUser: { id: "student", name: "김학생", studentNumber: "24101" },
        targetUserId: "student"
      }
    ]);

    expect(csv).toContain("시각,분류,액션,처리자,처리자학번,대상,대상학번,사유,예약ID");
    expect(csv).toContain('2026-06-12T04:30:00.000Z,RESTRICTION,USER_RESTRICTION_APPLY,관리자,teacher,김학생,24101,"예약 취소, 3일 제한",');
  });
});

const statistics: AdminStatistics = {
  dailyStats: [{ cancelledCount: 1, confirmedCount: 1, date: "2026-06-12", noShowCount: 1, totalCount: 3 }],
  from: "2026-06-12",
  periodStats: [
    {
      cancelledCount: 1,
      capacity: 10,
      confirmedCount: 0,
      fillRate: 0,
      label: "8면학",
      noShowCount: 1,
      studyPeriod: "EIGHTH",
      totalCount: 2
    },
    {
      cancelledCount: 0,
      capacity: 10,
      confirmedCount: 1,
      fillRate: 10,
      label: "1면학",
      noShowCount: 0,
      studyPeriod: "FIRST",
      totalCount: 1
    }
  ],
  repeatedOffenders: [
    {
      cancelledCount: 1,
      name: "박반복",
      noShowCount: 1,
      studentNumber: "24102",
      totalIncidents: 2,
      userId: "user-b"
    }
  ],
  to: "2026-06-12",
  totals: { cancelledCount: 1, confirmedCount: 1, noShowCount: 1, totalCount: 3, uniqueStudentCount: 2 }
};

function reservation(input: { readonly name: string; readonly reason?: string | null; readonly studentNumber: string }): AdminReservation {
  return {
    createdAt: "2026-06-12T04:00:00.000Z",
    date: "2026-06-12",
    id: "reservation-1",
    reason: input.reason ?? "자습",
    status: "CONFIRMED",
    studyPeriod: "EIGHTH",
    user: {
      bookingStatus: "ACTIVE",
      id: "user-1",
      name: input.name,
      role: "STUDENT",
      studentNumber: input.studentNumber
    }
  };
}
