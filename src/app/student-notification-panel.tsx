"use client";

import { Bell, ChevronDown, LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useState } from "react";

import type { StudentNotification } from "@/lib/student-notifications";
import { formatKstTime } from "@/lib/student-reservation-status";
import { readStudentNotificationsPayload, type StudentNotificationsReadResult } from "./client-api-response";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type StudentNotificationPanelProps = {
  readonly user: ReservationSidebarUser | null;
};

type StudentNotificationState = {
  readonly errorMessage: string | null;
  readonly loading: boolean;
  readonly notifications: readonly StudentNotification[];
};

const EMPTY_NOTIFICATION_STATE = {
  errorMessage: null,
  loading: false,
  notifications: []
} satisfies StudentNotificationState;

const STUDENT_NOTIFICATION_REFRESH_INTERVAL_MS = 60_000;

export function StudentNotificationPanel({ user }: StudentNotificationPanelProps): ReactElement {
  const state = useStudentNotificationState(user);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const latestNotification = state.notifications[0] ?? null;
  const countLabel = state.notifications.length > 9 ? "9+" : String(state.notifications.length);

  useEffect(() => {
    setOpen(false);
  }, [user?.id, user?.role]);

  return (
    <section
      aria-label="학생 알림"
      className="student-notification-widget"
      data-open={open}
      data-state={notificationStateName(user, state)}
    >
      <button
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={open ? "학생 알림 닫기" : "학생 알림 열기"}
        className="student-notification-head"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="student-notification-title">
          <Bell aria-hidden="true" size={16} />
          알림
        </span>
        <span className="student-notification-actions">
          {state.loading ? <LoaderCircle aria-hidden="true" className="student-notification-spinner" size={14} /> : null}
          {!state.loading && state.notifications.length > 0 ? (
            <strong className="student-notification-count">{countLabel}</strong>
          ) : null}
          <ChevronDown aria-hidden="true" className="student-notification-chevron" size={16} />
        </span>
      </button>
      <div aria-live="polite" className="student-notification-body" hidden={!open} id={bodyId}>
        {notificationBody(user, state, latestNotification)}
      </div>
    </section>
  );
}

function useStudentNotificationState(user: ReservationSidebarUser | null): StudentNotificationState {
  const [state, setState] = useState<StudentNotificationState>(EMPTY_NOTIFICATION_STATE);

  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (!canReadStudentNotifications(user)) {
      setState(EMPTY_NOTIFICATION_STATE);
      return;
    }

    setState((current) => ({ ...current, errorMessage: null, loading: true }));
    const result = await fetchStudentNotifications();
    switch (result.kind) {
      case "loaded":
        setState({ errorMessage: null, loading: false, notifications: result.notifications });
        return;
      case "error":
        setState((current) => ({ ...current, errorMessage: result.message, loading: false }));
        return;
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!canReadStudentNotifications(user)) {
      setState(EMPTY_NOTIFICATION_STATE);
      return;
    }

    void refreshNotifications();
    const intervalId = window.setInterval(() => void refreshNotifications(), STUDENT_NOTIFICATION_REFRESH_INTERVAL_MS);
    const refreshOnVisible = (): void => {
      if (document.visibilityState === "visible") {
        void refreshNotifications();
      }
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refreshNotifications, user?.id, user?.role]);

  return state;
}

async function fetchStudentNotifications(): Promise<StudentNotificationsReadResult> {
  try {
    return await readStudentNotificationsPayload(await fetch("/api/me/notifications"));
  } catch (error) {
    if (error instanceof TypeError) {
      return { kind: "error", message: "알림을 불러오지 못했습니다." };
    }
    throw error;
  }
}

function notificationBody(
  user: ReservationSidebarUser | null,
  state: StudentNotificationState,
  latestNotification: StudentNotification | null
): ReactElement {
  if (!canReadStudentNotifications(user)) {
    return <p className="student-notification-muted">로그인 후 표시</p>;
  }
  if (state.errorMessage) {
    return <p className="student-notification-muted">{state.errorMessage}</p>;
  }
  if (latestNotification) {
    return (
      <article className="student-notification-item">
        <div>
          <strong>{latestNotification.title}</strong>
          <time dateTime={latestNotification.createdAt}>{formatKstTime(latestNotification.createdAt)}</time>
        </div>
        <p>{latestNotification.message}</p>
        {latestNotification.reason ? <p className="student-notification-reason">사유 {latestNotification.reason}</p> : null}
      </article>
    );
  }
  return <p className="student-notification-muted">{state.loading ? "확인 중" : "새 알림 없음"}</p>;
}

function notificationStateName(user: ReservationSidebarUser | null, state: StudentNotificationState): string {
  if (!canReadStudentNotifications(user)) {
    return "signed-out";
  }
  if (state.errorMessage) {
    return "error";
  }
  if (state.notifications.length > 0) {
    return "active";
  }
  return state.loading ? "loading" : "empty";
}

function canReadStudentNotifications(user: ReservationSidebarUser | null): boolean {
  return user !== null && user.role !== "ADMIN";
}
