"use client";

import { Bell, ChevronDown, LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { StudentNotification } from "@/lib/student-notifications";
import { buildStudentNotificationPresentation } from "@/lib/student-notifications";
import { formatKstTime } from "@/lib/student-reservation-status";
import { readStudentNotificationsPayload, type StudentNotificationsReadResult } from "./client-api-response";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type StudentNotificationPanelProps = {
  readonly authenticationGeneration: number;
  readonly user: ReservationSidebarUser | null;
};

type StudentNotificationState = {
  readonly authenticationGeneration: number;
  readonly errorMessage: string | null;
  readonly loading: boolean;
  readonly notifications: readonly StudentNotification[];
  readonly userId: string | null;
};

const EMPTY_NOTIFICATION_STATE = {
  authenticationGeneration: -1,
  errorMessage: null,
  loading: false,
  notifications: [],
  userId: null
} satisfies StudentNotificationState;

const STUDENT_NOTIFICATION_REFRESH_INTERVAL_MS = 60_000;

export function StudentNotificationPanel({ authenticationGeneration, user }: StudentNotificationPanelProps): ReactElement {
  const loadedState = useStudentNotificationState(authenticationGeneration, user);
  const state =
    loadedState.authenticationGeneration === authenticationGeneration && loadedState.userId === (user?.id ?? null)
      ? loadedState
      : { ...EMPTY_NOTIFICATION_STATE, authenticationGeneration, userId: user?.id ?? null };
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const presentation = studentNotificationPresentation(state);
  const countLabel = presentation.count > 9 ? "9+" : String(presentation.count);

  useEffect(() => {
    setOpen(false);
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

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
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="student-notification-title">
          <Bell aria-hidden="true" size={16} />
          알림
        </span>
        <span className="student-notification-actions">
          {state.loading ? <LoaderCircle aria-hidden="true" className="student-notification-spinner" size={14} /> : null}
          {!state.loading && presentation.count > 0 ? (
            <strong className="student-notification-count">{countLabel}</strong>
          ) : null}
          <ChevronDown aria-hidden="true" className="student-notification-chevron" size={16} />
        </span>
      </button>
      {open ? (
        <div aria-live="polite" className="student-notification-body" id={bodyId}>
          {notificationBody(user, state, presentation.notifications)}
        </div>
      ) : null}
    </section>
  );
}

function useStudentNotificationState(
  authenticationGeneration: number,
  user: ReservationSidebarUser | null
): StudentNotificationState {
  const [state, setState] = useState<StudentNotificationState>(EMPTY_NOTIFICATION_STATE);
  const latestRequestGenerationRef = useRef(0);
  const currentOwnerRef = useRef({ authenticationGeneration, userId: user?.id ?? null });
  currentOwnerRef.current = { authenticationGeneration, userId: user?.id ?? null };

  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (user === null || user.role === "ADMIN") {
      latestRequestGenerationRef.current += 1;
      setState(EMPTY_NOTIFICATION_STATE);
      return;
    }

    const requestGeneration = latestRequestGenerationRef.current + 1;
    latestRequestGenerationRef.current = requestGeneration;
    const ownerUserId = user.id;
    setState((current) => ({
      authenticationGeneration,
      errorMessage: null,
      loading: true,
      notifications: current.userId === ownerUserId ? current.notifications : [],
      userId: ownerUserId
    }));
    const result = await fetchStudentNotifications();
    if (
      requestGeneration !== latestRequestGenerationRef.current ||
      currentOwnerRef.current.authenticationGeneration !== authenticationGeneration ||
      currentOwnerRef.current.userId !== ownerUserId
    ) {
      return;
    }
    switch (result.kind) {
      case "loaded":
        setState({
          authenticationGeneration,
          errorMessage: null,
          loading: false,
          notifications: result.notifications,
          userId: ownerUserId
        });
        return;
      case "error":
        setState((current) => ({ ...current, errorMessage: result.message, loading: false }));
        return;
    }
  }, [authenticationGeneration, user?.id, user?.role]);

  useEffect(() => {
    if (!canReadStudentNotifications(user)) {
      latestRequestGenerationRef.current += 1;
      setState(EMPTY_NOTIFICATION_STATE);
      return;
    }

    void refreshNotifications();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshNotifications();
      }
    }, STUDENT_NOTIFICATION_REFRESH_INTERVAL_MS);
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
  }, [authenticationGeneration, refreshNotifications, user?.id, user?.role]);

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
  notifications: readonly StudentNotification[]
): ReactElement {
  if (!canReadStudentNotifications(user)) {
    return <p className="student-notification-muted">로그인 후 표시</p>;
  }
  if (state.errorMessage && notifications.length === 0) {
    return <p className="student-notification-muted">{state.errorMessage}</p>;
  }
  if (notifications.length > 0) {
    return (
      <div className="student-notification-list">
        {state.errorMessage ? <p className="student-notification-muted">{state.errorMessage}</p> : null}
        {notifications.map((notification) => (
          <article className="student-notification-item" key={notification.id}>
            <div>
              <strong>{notification.title}</strong>
              <time dateTime={notification.createdAt}>{formatKstTime(notification.createdAt)}</time>
            </div>
            <p>{notification.message}</p>
            {notification.reason ? <p className="student-notification-reason">사유 {notification.reason}</p> : null}
          </article>
        ))}
      </div>
    );
  }
  return <p className="student-notification-muted">{state.loading ? "확인 중" : "새 알림 없음"}</p>;
}

function studentNotificationPresentation(state: StudentNotificationState) {
  if (state.loading && state.notifications.length === 0) {
    return buildStudentNotificationPresentation({ kind: "loading" });
  }
  return buildStudentNotificationPresentation({
    kind: state.loading || state.errorMessage ? "stale" : "loaded",
    notifications: state.notifications
  });
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
