"use client";

import { AlertCircle, CalendarCheck, History, RefreshCw, ShieldAlert, UserRound, X } from "lucide-react";
import type { ReactElement } from "react";
import { useId, useRef } from "react";

import { useDialogFocus } from "@/components/use-dialog-focus";
import type { StudentProfilePayload } from "@/lib/student-profile";
import { getStudyPeriodLabel } from "@/lib/study-periods";

export type StudentProfilePanelProps = {
  readonly errorMessage: string | null;
  readonly loading: boolean;
  readonly open: boolean;
  readonly profile: StudentProfilePayload | null;
  readonly onClose: () => void;
  readonly onRetry: () => void;
};

type ProfileReservation = StudentProfilePayload["recentReservations"][number];
type ProfileSanction = StudentProfilePayload["recentSanctions"][number];
type ProfileStatus = StudentProfilePayload["effectiveStatus"];
type ProfileStatusView = {
  readonly label: string;
  readonly tone: string;
};

export function StudentProfilePanel({
  errorMessage,
  loading,
  open,
  profile,
  onClose,
  onRetry
}: StudentProfilePanelProps): ReactElement | null {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = !loading && errorMessage ? retryRef : closeRef;
  const focusState = loading ? "loading" : errorMessage ? "error" : profile ? "loaded" : "empty";
  useDialogFocus({ canDismiss: !loading, dialogRef, initialFocusKey: focusState, initialFocusRef, onDismiss: onClose, open });

  if (!open) {
    return null;
  }

  return (
    <div className="student-profile-backdrop" role="presentation" onClick={(event) => {
      if (!loading && event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <aside aria-busy={loading} aria-labelledby={titleId} aria-modal="true" className="student-profile-panel" ref={dialogRef} role="dialog">
        <header className="student-profile-head">
          <span className="student-profile-mark" aria-hidden="true">
            <UserRound size={20} />
          </span>
          <div className="student-profile-title">
            <h2 id={titleId}>프로필</h2>
            {profile ? <p className="muted">{profile.user.name} {profile.user.studentNumber}</p> : null}
          </div>
          <button aria-label="닫기" className="icon-button" disabled={loading} ref={closeRef} type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        {loading ? <StudentProfileLoading /> : null}
        {!loading && errorMessage ? (
          <StudentProfileError message={errorMessage} retryRef={retryRef} onRetry={onRetry} />
        ) : null}
        {!loading && !errorMessage && profile ? <StudentProfileContent profile={profile} /> : null}
      </aside>
    </div>
  );
}

function StudentProfileLoading(): ReactElement {
  return (
    <div aria-busy="true" className="student-profile-loading">
      <span className="student-profile-skeleton student-profile-skeleton-status" />
      <span className="student-profile-skeleton" />
      <span className="student-profile-skeleton" />
      <span className="student-profile-skeleton" />
    </div>
  );
}

function StudentProfileError({
  message,
  retryRef,
  onRetry
}: {
  readonly message: string;
  readonly retryRef: React.RefObject<HTMLButtonElement | null>;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div className="student-profile-error">
      <AlertCircle aria-hidden="true" size={20} />
      <p>{message}</p>
      <button className="ghost-button" ref={retryRef} type="button" onClick={onRetry}>
        <RefreshCw aria-hidden="true" size={16} />
        다시 시도
      </button>
    </div>
  );
}

function StudentProfileContent({ profile }: { readonly profile: StudentProfilePayload }): ReactElement {
  const restrictionNote = getRestrictionNote(profile);
  const statusView = getProfileStatusView(profile.effectiveStatus);

  return (
    <div className="student-profile-body">
      <div className="student-profile-status-row">
        <span className="student-profile-status" data-status={statusView.tone}>{statusView.label}</span>
        {restrictionNote ? <span className="student-profile-note">{restrictionNote}</span> : null}
      </div>

      <dl className="student-profile-metrics">
        <div className="student-profile-metric">
          <dt>확정</dt>
          <dd>{profile.reservationSummary.confirmedCount}</dd>
        </div>
        <div className="student-profile-metric">
          <dt>취소</dt>
          <dd>{profile.reservationSummary.cancelledCount}</dd>
        </div>
        <div className="student-profile-metric">
          <dt>미출석</dt>
          <dd>{profile.reservationSummary.noShowCount}</dd>
        </div>
      </dl>

      <StudentProfileSection icon={<CalendarCheck size={17} />} title="현재 예약">
        <ReservationList emptyState="empty-current-reservation" reservations={profile.currentReservations} />
      </StudentProfileSection>

      <StudentProfileSection icon={<History size={17} />} title="최근 이력">
        <ReservationList emptyState="empty-history" reservations={profile.recentReservations} />
      </StudentProfileSection>

      <StudentProfileSection icon={<ShieldAlert size={17} />} title="제재 이력">
        <SanctionList sanctions={profile.recentSanctions} />
      </StudentProfileSection>
    </div>
  );
}

function StudentProfileSection({
  children,
  icon,
  title
}: {
  readonly children: ReactElement;
  readonly icon: ReactElement;
  readonly title: string;
}): ReactElement {
  return (
    <section className="student-profile-section">
      <h3>
        <span aria-hidden="true">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ReservationList({
  emptyState,
  reservations
}: {
  readonly emptyState: "empty-current-reservation" | "empty-history";
  readonly reservations: readonly ProfileReservation[];
}): ReactElement {
  if (reservations.length === 0) {
    return (
      <ul className="student-profile-list" data-empty={emptyState}>
        <li className="student-profile-empty">{getReservationEmptyLabel(emptyState)}</li>
      </ul>
    );
  }

  return (
    <ul className="student-profile-list">
      {reservations.map((reservation) => (
        <li className="student-profile-line" key={`${reservation.date}-${reservation.studyPeriod}-${reservation.createdAt}`}>
          <span className="student-profile-line-main">{formatDate(reservation.date)} {getStudyPeriodLabel(reservation.studyPeriod)}</span>
          <span className="student-profile-line-meta">{getReservationStatusLabel(reservation.status)}</span>
        </li>
      ))}
    </ul>
  );
}

function SanctionList({ sanctions }: { readonly sanctions: readonly ProfileSanction[] }): ReactElement {
  if (sanctions.length === 0) {
    return (
      <ul className="student-profile-list" data-empty="empty-sanction">
        <li className="student-profile-empty">제재 이력 없음</li>
      </ul>
    );
  }

  return (
    <ul className="student-profile-list">
      {sanctions.map((sanction) => (
        <li className="student-profile-line" key={`${sanction.createdAt}-${sanction.reason}`}>
          <span className="student-profile-line-main">{formatSanctionRange(sanction)} {sanction.reason}</span>
          <span className="student-profile-line-meta">{getSanctionStatusLabel(sanction)}</span>
        </li>
      ))}
    </ul>
  );
}

function getReservationEmptyLabel(emptyState: "empty-current-reservation" | "empty-history"): string {
  switch (emptyState) {
    case "empty-current-reservation":
      return "현재 예약 없음";
    case "empty-history":
      return "최근 이력 없음";
  }
}

function getRestrictionNote(profile: StudentProfilePayload): string | null {
  const reason = profile.user.restrictionReason;
  const until = profile.user.restrictedUntil === null ? null : formatDate(profile.user.restrictedUntil);

  if (reason !== null && until !== null) {
    return `${reason} ${until}`;
  }

  return reason ?? until;
}

function getProfileStatusView(status: ProfileStatus): ProfileStatusView {
  switch (status) {
    case "ACTIVE":
    case "SHADOW_BANNED":
      return { label: "예약 가능", tone: "available" };
    case "BANNED":
      return { label: "영구 제한", tone: "banned" };
    case "RESTRICTED":
      return { label: "예약 제한", tone: "restricted" };
    default:
      return assertNever(status);
  }
}

function getReservationStatusLabel(status: ProfileReservation["status"]): string {
  switch (status) {
    case "CANCELLED":
      return "취소";
    case "CONFIRMED":
      return "확정";
    case "NO_SHOW":
      return "미출석";
    default:
      return assertNever(status);
  }
}

function getSanctionStatusLabel(sanction: ProfileSanction): string {
  switch (sanction.status) {
    case "ACTIVE":
      return sanction.endsAt === null ? "영구 제한" : "예약 제한";
    case "REVOKED":
      return "취소";
    default:
      return assertNever(sanction.status);
  }
}

function formatDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function formatSanctionRange(sanction: ProfileSanction): string {
  const start = formatDate(sanction.startsAt);

  if (sanction.endsAt === null) {
    return `${start} - 영구 제한`;
  }

  return `${start} - ${formatDate(sanction.endsAt)}`;
}

function assertNever(value: never): never {
  throw new UnreachableStudentProfilePanelVariantError(String(value));
}

class UnreachableStudentProfilePanelVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled student profile panel variant: ${value}`);
    this.name = "UnreachableStudentProfilePanelVariantError";
  }
}
