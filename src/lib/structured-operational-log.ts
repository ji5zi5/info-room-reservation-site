export type StructuredOperationalEvent = {
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly event: "maintenance.reservation" | "maintenance.stage";
  readonly jobId: string;
  readonly reservationId?: string;
  readonly result: "blocked" | "failed" | "succeeded";
  readonly runId: string;
  readonly stage: string;
};

type OperationalLogSink = (line: string) => void;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function serializeStructuredOperationalEvent(event: StructuredOperationalEvent): string {
  return JSON.stringify({
    durationMs: Math.max(0, Math.trunc(event.durationMs)),
    errorCode: sanitizeErrorCode(event.errorCode),
    event: event.event,
    jobId: sanitizeIdentifier(event.jobId),
    ...(event.reservationId === undefined
      ? {}
      : { reservationId: sanitizeIdentifier(event.reservationId) }),
    result: event.result,
    runId: sanitizeIdentifier(event.runId),
    stage: sanitizeIdentifier(event.stage)
  });
}

export function emitStructuredOperationalEvent(
  event: StructuredOperationalEvent,
  sink: OperationalLogSink = console.info
): void {
  sink(serializeStructuredOperationalEvent(event));
}

function sanitizeIdentifier(value: string): string {
  return SAFE_IDENTIFIER.test(value) ? value : "redacted";
}

function sanitizeErrorCode(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_ERROR_CODE.test(value) ? value : "redacted_error";
}
