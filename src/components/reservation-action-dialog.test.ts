import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReservationActionDialog } from "./reservation-action-dialog";

describe("ReservationActionDialog", () => {
  it("renders the current action error once as an alert inside the open dialog", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationActionDialog, {
        action: {
          kind: "cancel",
          label: "8면학",
          reservationId: "reservation-1",
          restrictedUntilPreview: "2026-08-12T00:00:00.000Z"
        },
        errorMessage: "보류된 요청 실패",
        loading: false,
        onClose: () => undefined,
        onConfirm: async () => ({ kind: "success" as const })
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup.match(/보류된 요청 실패/g)).toHaveLength(1);
  });

  it.each([
    {
      kind: "reserve",
      action: { kind: "reserve", label: "8면학", studyPeriod: "EIGHTH" } as const,
      commandName: "신청하기"
    },
    {
      kind: "cancel",
      action: {
        kind: "cancel",
        label: "8면학",
        reservationId: "reservation-1",
        restrictedUntilPreview: "2026-08-12T00:00:00.000Z"
      } as const,
      commandName: "취소 확정"
    }
  ])("keeps the $kind command name stable while pending", ({ action, commandName }) => {
    const markup = renderToStaticMarkup(
      createElement(ReservationActionDialog, {
        action,
        errorMessage: null,
        loading: true,
        onClose: () => undefined,
        onConfirm: async () => ({ kind: "success" as const })
      })
    );

    expect(markup).toContain(`aria-label="${commandName}"`);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('type="button"');
    expect(markup).toContain(">처리 중</button>");
  });

  it("renders a disabled busy recovery command inside a stale reservation dialog", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationActionDialog, {
        action: { kind: "reserve", label: "8면학", studyPeriod: "EIGHTH" },
        errorMessage: "최신 정보를 다시 불러온 뒤 확인해주세요.",
        loading: false,
        onClose: () => undefined,
        onConfirm: async () => ({ kind: "success" as const }),
        onRefreshRetry: () => undefined,
        refreshRetrying: true
      })
    );

    expect(markup).toContain('aria-label="다시 불러오기"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('class="ghost-button"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("다시 불러오는 중");
  });

  it("omits the recovery command when no retry handler exists", () => {
    const markup = renderToStaticMarkup(
      createElement(ReservationActionDialog, {
        action: { kind: "reserve", label: "8면학", studyPeriod: "EIGHTH" },
        errorMessage: "최신 정보를 다시 불러온 뒤 확인해주세요.",
        loading: false,
        onClose: () => undefined,
        onConfirm: async () => ({ kind: "success" as const })
      })
    );

    expect(markup).not.toContain('aria-label="다시 불러오기"');
  });
});
