"use client";

import { ExternalLink, RotateCcw, Search, ShieldX, Unlink } from "lucide-react";
import { useState, type ReactElement } from "react";

import { AdminConfirmationDialog } from "./admin-confirmation-dialog";
import type { AdminMutationResult } from "./admin-api-client";
import type { AdminConsoleDeepLinkTarget } from "./admin-console-url";
import type {
  AdminOperationItem,
  AdminOperationRepairAction,
  AdminOperationsPayload
} from "./admin-types";

type AdminOperationsPanelProps = {
  readonly onNavigate: (target: AdminConsoleDeepLinkTarget) => void;
  readonly onRepair: (item: AdminOperationItem, action: AdminOperationRepairAction) => Promise<AdminMutationResult<unknown>>;
  readonly operations: AdminOperationsPayload;
};

const BACKLOGS = [
  { key: "interactions", label: "Discord 명령" },
  { key: "initialSends", label: "초기 전송" },
  { key: "syncs", label: "메시지 동기화" }
] as const;

export function AdminOperationsPanel({
  onNavigate,
  onRepair,
  operations
}: AdminOperationsPanelProps): ReactElement {
  const [confirmation, setConfirmation] = useState<{
    readonly action: AdminOperationRepairAction;
    readonly item: AdminOperationItem;
  } | null>(null);

  function requestRepair(item: AdminOperationItem, action: AdminOperationRepairAction): void {
    if (destructiveAction(action)) {
      setConfirmation({ action, item });
      return;
    }
    void onRepair(item, action);
  }

  return (
    <section aria-label="운영 작업 상태" className="admin-operations-panel">
      <div className="admin-operations-heading">
        <h3>작업 상태</h3>
        <span className="muted">기준 {formatKst(operations.generatedAt)}</span>
      </div>
      <div className="admin-job-health-list">
        {operations.jobs.map((job) => (
          <article className="admin-job-health-row" data-health={job.health.status} key={job.job}>
            <div className="admin-job-health-title">
              <strong>{jobLabel(job.job)}</strong>
              <span className="notification-pill" data-status={job.health.status}>
                {healthLabel(job.health.code)}
              </span>
            </div>
            <dl className="admin-operation-facts">
              <div><dt>마지막 성공</dt><dd>{formatOptionalKst(job.lastSuccessAt)}</dd></div>
              <div><dt>마지막 시도</dt><dd>{formatOptionalKst(job.lastAttemptAt)}</dd></div>
              <div><dt>대기</dt><dd>{job.backlogCount}건</dd></div>
              <div><dt>오류 코드</dt><dd>{job.failureCode ?? "없음"}</dd></div>
            </dl>
          </article>
        ))}
      </div>
      {BACKLOGS.map(({ key, label }) => {
        const backlog = operations.backlogs[key];
        return (
          <section aria-label={label} className="admin-operation-backlog" key={key}>
            <div className="admin-operation-backlog-heading">
              <h4>{label}</h4>
              <span>{`${backlog.count}건 · 가장 오래된 항목 ${formatAge(backlog.oldestAgeMs)}`}</span>
            </div>
            {backlog.items.map((item) => (
              <OperationRow
                item={item}
                key={`${item.kind}-${item.id}`}
                onNavigate={onNavigate}
                onRepair={requestRepair}
              />
            ))}
          </section>
        );
      })}
      {confirmation ? (
        <AdminConfirmationDialog
          cancelLabel="돌아가기"
          confirmLabel={repairLabel(confirmation.action)}
          title={`${repairLabel(confirmation.action)} 확인`}
          onConfirm={() => onRepair(confirmation.item, confirmation.action)}
          onDismiss={() => setConfirmation(null)}
        >
          <p>예약 {confirmation.item.reservationId}</p>
        </AdminConfirmationDialog>
      ) : null}
    </section>
  );
}

function OperationRow({
  item,
  onNavigate,
  onRepair
}: {
  readonly item: AdminOperationItem;
  readonly onNavigate: AdminOperationsPanelProps["onNavigate"];
  readonly onRepair: (item: AdminOperationItem, action: AdminOperationRepairAction) => void;
}): ReactElement {
  return (
    <div className="admin-operation-row">
      <div className="admin-operation-summary">
        <strong>{operationStatusLabel(item)}</strong>
        <span className="muted">갱신 {formatKst(item.updatedAt)}</span>
        {item.kind === "interaction" && item.errorCode ? <code>{item.errorCode}</code> : null}
      </div>
      <div className="admin-operation-links" aria-label="관련 기록">
        <LinkButton label="예약 보기" title="예약 상세 열기" onClick={() => onNavigate({ kind: "reservation", reservationId: item.reservationId })} />
        <LinkButton label="학생 보기" title="학생 상세 열기" onClick={() => onNavigate({ kind: "user", userId: item.userId })} />
        {item.latestAuditActionId ? (
          <LinkButton label="감사 기록 보기" title="감사 기록 열기" onClick={() => onNavigate({ actionId: item.latestAuditActionId ?? "", kind: "audit" })} />
        ) : null}
      </div>
      <div className="admin-operation-actions">
        {item.permittedActions.map((action) => (
          <button className={destructiveAction(action) ? "danger-button" : "ghost-button"} key={action} title={repairTooltip(action)} type="button" onClick={() => onRepair(item, action)}>
            {repairIcon(action)}
            {repairLabel(action)}
          </button>
        ))}
      </div>
    </div>
  );
}

function LinkButton({ label, onClick, title }: { readonly label: string; readonly onClick: () => void; readonly title: string }): ReactElement {
  return <button className="text-button" title={title} type="button" onClick={onClick}><ExternalLink size={14} />{label}</button>;
}

function healthLabel(code: AdminOperationsPayload["jobs"][number]["health"]["code"]): string {
  switch (code) {
    case "healthy": return "정상";
    case "running": return "실행 중";
    case "running_timeout": return "실행 시간 초과";
    case "stale": return "실행 지연";
    case "last_attempt_failed": return "최근 실행 실패";
    case "repeated_failures": return "반복 실패";
    case "never_run": return "실행 기록 없음";
    case "never_succeeded": return "성공 기록 없음";
    case "disabled": return "중지됨";
  }
}

function jobLabel(job: AdminOperationsPayload["jobs"][number]["job"]): string {
  switch (job) {
    case "CLOSED_PERIOD_NOTIFICATIONS": return "마감 명단";
    case "DISCORD_INTERACTIONS": return "Discord 명령 처리";
    case "DISCORD_RESERVATION_OUTBOX": return "Discord 예약 메시지";
  }
}

function operationStatusLabel(item: AdminOperationItem): string {
  if (item.kind === "sync" && item.messageRevision > item.syncedRevision) return `동기화 지연 · ${item.syncedRevision}/${item.messageRevision}`;
  switch (item.status) {
    case "RETRY": return "재시도 대기";
    case "PENDING_REVIEW": return "확인 필요";
    case "ABANDONED": return "처리 종료";
    default: return item.status;
  }
}

function repairLabel(action: AdminOperationRepairAction): string {
  switch (action) {
    case "verify_remote": return "원격 확인";
    case "retry": return "다시 시도";
    case "sync": return "동기화";
    case "remove_controls": return "컨트롤 제거";
    case "abandon": return "처리 종료";
  }
}

function repairTooltip(action: AdminOperationRepairAction): string {
  switch (action) {
    case "verify_remote": return "Discord 채널에서 원격 메시지 확인";
    case "retry": return "확실히 실패한 작업 다시 시도";
    case "sync": return "최신 예약 상태로 메시지 동기화";
    case "remove_controls": return "종료된 예약의 Discord 컨트롤 제거";
    case "abandon": return "원격 확인이 끝나지 않은 작업 종료";
  }
}

function repairIcon(action: AdminOperationRepairAction): ReactElement {
  switch (action) {
    case "verify_remote": return <Search size={15} />;
    case "retry": return <RotateCcw size={15} />;
    case "sync": return <RotateCcw size={15} />;
    case "remove_controls": return <Unlink size={15} />;
    case "abandon": return <ShieldX size={15} />;
  }
}

function destructiveAction(action: AdminOperationRepairAction): boolean {
  return action === "remove_controls" || action === "abandon";
}

function formatOptionalKst(value: string | null): string {
  return value === null ? "없음" : formatKst(value);
}

function formatKst(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { day: "2-digit", hour: "2-digit", minute: "2-digit", month: "2-digit", timeZone: "Asia/Seoul" }).format(new Date(value));
}

function formatAge(value: number | null): string {
  if (value === null) return "없음";
  const hours = Math.floor(value / 3_600_000);
  if (hours >= 1) return `${hours}시간`;
  return `${Math.max(1, Math.floor(value / 60_000))}분`;
}
