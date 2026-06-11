"use client";

import { Ban, CalendarClock, RotateCcw, Save, UserX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type PeriodSummary = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: "EIGHTH" | "FIRST";
};

type AdminReservation = {
  readonly date: string;
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: string;
  readonly user: {
    readonly bookingStatus: string;
    readonly id: string;
    readonly name: string;
    readonly studentNumber: string;
  };
};

export default function AdminPage(): React.ReactElement {
  const [date, setDate] = useState(todayKst());
  const [periods, setPeriods] = useState<readonly PeriodSummary[]>([]);
  const [reservations, setReservations] = useState<readonly AdminReservation[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const orderedPeriods = useMemo(() => periods, [periods]);

  useEffect(() => {
    void refresh();
  }, [date]);

  async function refresh(): Promise<void> {
    const [settingsResponse, reservationsResponse] = await Promise.all([
      fetch(`/api/admin/period-settings?date=${date}`),
      fetch(`/api/admin/reservations?date=${date}`)
    ]);

    if (settingsResponse.status === 401 || settingsResponse.status === 403) {
      setToast("관리자 로그인이 필요합니다. 메인에서 admin 계정으로 로그인하세요.");
      return;
    }

    const settingsPayload = (await settingsResponse.json()) as { readonly periods: readonly PeriodSummary[] };
    const reservationsPayload = (await reservationsResponse.json()) as { readonly reservations: readonly AdminReservation[] };
    setPeriods(settingsPayload.periods);
    setReservations(reservationsPayload.reservations);
  }

  async function save(): Promise<void> {
    const response = await fetch("/api/admin/period-settings", {
      body: JSON.stringify({
        date,
        periods: orderedPeriods.map((period) => ({
          capacity: period.capacity,
          closeTime: period.closeTime,
          enabled: period.enabled,
          openTime: period.openTime,
          studyPeriod: period.studyPeriod
        }))
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
    setToast(response.ok ? "설정이 저장되었습니다." : "설정 저장에 실패했습니다.");
    await refresh();
  }

  async function markNoShow(reservationId: string): Promise<void> {
    const response = await fetch(`/api/admin/reservations/${reservationId}/no-show`, {
      body: JSON.stringify({ days: 7, reason: "정보실 예약 노쇼" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    setToast(response.ok ? "노쇼 처리와 예약 제한을 적용했습니다." : "노쇼 처리 실패");
    await refresh();
  }

  async function removeRestriction(userId: string): Promise<void> {
    const response = await fetch(`/api/admin/users/${userId}/restriction`, { method: "DELETE" });
    setToast(response.ok ? "예약 제한을 해제했습니다." : "제한 해제 실패");
    await refresh();
  }

  function updatePeriod(studyPeriod: "EIGHTH" | "FIRST", patch: Partial<PeriodSummary>): void {
    setPeriods((current) =>
      current.map((period) => (period.studyPeriod === studyPeriod ? { ...period, ...patch } : period))
    );
  }

  return (
    <main className="app-shell">
      <div className="admin-grid">
        <section className="admin-panel stack">
          <div className="brand-row">
            <span className="brand-mark">
              <CalendarClock size={22} />
            </span>
            <a className="ghost-button" href="/">예약 화면</a>
          </div>
          <div>
            <h1>관리자</h1>
            <p className="muted">8면학, 1면학 오픈 · 마감 · 정원</p>
          </div>
          <label className="field">
            <span>예약 날짜</span>
            <input type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} />
          </label>
          <div className="stack">
            {orderedPeriods.map((period) => (
              <div className="period-card" key={period.studyPeriod}>
                <div className="period-top">
                  <h3>{period.label}</h3>
                  <label className="row">
                    <span className="muted">사용</span>
                    <input
                      checked={period.enabled}
                      type="checkbox"
                      onChange={(event) => updatePeriod(period.studyPeriod, { enabled: event.currentTarget.checked })}
                    />
                  </label>
                </div>
                <div className="admin-row">
                  <label className="field">
                    <span>오픈</span>
                    <input
                      value={period.openTime}
                      onChange={(event) => updatePeriod(period.studyPeriod, { openTime: event.currentTarget.value })}
                    />
                  </label>
                  <label className="field">
                    <span>마감</span>
                    <input
                      value={period.closeTime}
                      onChange={(event) => updatePeriod(period.studyPeriod, { closeTime: event.currentTarget.value })}
                    />
                  </label>
                  <label className="field">
                    <span>정원</span>
                    <input
                      min={1}
                      type="number"
                      value={period.capacity}
                      onChange={(event) => updatePeriod(period.studyPeriod, { capacity: Number(event.currentTarget.value) })}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <button className="primary-button" type="button" onClick={() => void save()}>
            <Save size={18} />
            저장
          </button>
          {toast ? <div className="toast">{toast}</div> : null}
        </section>

        <section className="admin-panel stack">
          <div className="topbar">
            <div>
              <h2>예약자 목록</h2>
              <p className="muted">노쇼 · 예약 제한 · 해제</p>
            </div>
            <button className="ghost-button" type="button" onClick={() => void refresh()}>
              <RotateCcw size={18} />
              새로고침
            </button>
          </div>
          <div className="table-list">
            {reservations.map((reservation) => (
              <div className="table-line" key={reservation.id}>
                <div>
                  <strong>{reservation.user.name}</strong>
                  <p className="muted">{reservation.user.studentNumber}</p>
                </div>
                <span>{reservation.studyPeriod === "EIGHTH" ? "8면학" : "1면학"}</span>
                <span>{reservation.status}</span>
                <div className="row">
                  <button className="danger-button" type="button" onClick={() => void markNoShow(reservation.id)}>
                    <UserX size={16} />
                    노쇼
                  </button>
                  {reservation.user.bookingStatus !== "ACTIVE" ? (
                    <button className="ghost-button" type="button" onClick={() => void removeRestriction(reservation.user.id)}>
                      <Ban size={16} />
                      해제
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {reservations.length === 0 ? <div className="table-line muted">아직 예약자가 없습니다.</div> : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).format(new Date());
}
