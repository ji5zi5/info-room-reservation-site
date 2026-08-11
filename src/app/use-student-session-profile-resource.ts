"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  NETWORK_ERROR_MESSAGE,
  readApiErrorMessage,
  readCurrentUser,
  readLoginPayload,
  type CurrentUserReadResult
} from "./client-api-response";
import { csrfFetch, resetCsrfToken } from "./csrf-fetch";
import { isLatestRequestGeneration, type AuthenticationOwner } from "./reservation-home-period-contracts";
import type { ReservationHomeProfileState } from "./reservation-home-view";
import { isCompactReservationView } from "./reservation-viewport";
import type { ReservationSidebarUser } from "./reservation-sidebar";
import { useStudentProfileResource } from "./use-student-profile-resource";

type StudentSessionProfileResourceInput = {
  readonly clearPendingActionRef: RefObject<() => void>;
  readonly clearPeriodsRef: RefObject<() => void>;
  readonly id: string;
  readonly password: string;
  readonly setLoading: (loading: boolean) => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly setToast: (message: string | null) => void;
};

type StudentSessionProfileResource = {
  readonly authenticationGeneration: number;
  readonly closeProfile: () => void;
  readonly getAuthenticationOwner: () => AuthenticationOwner;
  readonly getSessionFreshness: () => boolean;
  readonly login: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly openProfile: () => void;
  readonly profileOpen: boolean;
  readonly profileState: ReservationHomeProfileState;
  readonly refreshMe: () => Promise<void>;
  readonly refreshProfile: () => Promise<void>;
  readonly sessionError: boolean;
  readonly sessionFresh: boolean;
  readonly user: ReservationSidebarUser | null;
};

export function useStudentSessionProfileResource(
  input: StudentSessionProfileResourceInput
): StudentSessionProfileResource {
  const [user, setUser] = useState<ReservationSidebarUser | null>(null);
  const userRef = useRef<ReservationSidebarUser | null>(null);
  const authenticationGenerationRef = useRef(0);
  const [authenticationGeneration, setAuthenticationGeneration] = useState(0);
  const [sessionFresh, setSessionFresh] = useState(false);
  const sessionFreshRef = useRef(false);
  const [sessionError, setSessionError] = useState(false);
  const sessionRequestGenerationRef = useRef(0);

  const commitSessionFreshness = useCallback((fresh: boolean): void => {
    sessionFreshRef.current = fresh;
    setSessionFresh(fresh);
  }, []);

  const getAuthenticationOwner = useCallback((): AuthenticationOwner => ({
    authenticationGeneration: authenticationGenerationRef.current,
    userId: userRef.current?.id ?? null
  }), []);
  const getSessionFreshness = useCallback((): boolean => sessionFreshRef.current, []);
  const {
    clearProfile,
    closeProfile,
    openProfile,
    profileOpen,
    profileState,
    refreshProfile
  } = useStudentProfileResource({ authenticationGeneration, getAuthenticationOwner, user });

  const clearStudentResources = useCallback((): void => {
    input.clearPeriodsRef.current();
    clearProfile();
    input.clearPendingActionRef.current();
    resetCsrfToken();
  }, [clearProfile, input.clearPendingActionRef, input.clearPeriodsRef]);

  const commitAuthenticationTransition = useCallback((nextUser: ReservationSidebarUser | null): void => {
    authenticationGenerationRef.current += 1;
    const nextGeneration = authenticationGenerationRef.current;
    userRef.current = nextUser;
    setAuthenticationGeneration(nextGeneration);
    setUser(nextUser);
    commitSessionFreshness(true);
    setSessionError(false);
    clearStudentResources();
  }, [clearStudentResources, commitSessionFreshness]);

  const commitSessionResult = useCallback((result: CurrentUserReadResult): void => {
    switch (result.kind) {
      case "error":
        commitSessionFreshness(false);
        setSessionError(true);
        return;
      case "unauthorized":
        commitAuthenticationTransition(null);
        input.setToast("로그인이 만료되었습니다. 다시 로그인해주세요.");
        return;
      case "loaded":
        if (result.user === null || result.user.id !== userRef.current?.id) {
          commitAuthenticationTransition(result.user);
          return;
        }
        userRef.current = result.user;
        setUser(result.user);
        commitSessionFreshness(true);
        setSessionError(false);
        return;
      default:
        return assertNever(result);
    }
  }, [commitAuthenticationTransition, commitSessionFreshness, input.setToast]);

  const refreshMe = useCallback(async (): Promise<void> => {
    const requestGeneration = sessionRequestGenerationRef.current + 1;
    sessionRequestGenerationRef.current = requestGeneration;
    try {
      const result = await readCurrentUser(await fetch("/api/me"));
      if (isLatestRequestGeneration(requestGeneration, sessionRequestGenerationRef.current)) {
        commitSessionResult(result);
      }
    } catch {
      if (isLatestRequestGeneration(requestGeneration, sessionRequestGenerationRef.current)) {
        commitSessionResult({ kind: "error" });
      }
    }
  }, [commitSessionResult]);

  const login = useCallback(async (): Promise<void> => {
    input.setLoading(true);
    input.setToast(null);
    try {
      const response = await fetch("/api/auth/riro/login", {
        body: JSON.stringify({ id: input.id, password: input.password }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = await readLoginPayload(response);
      if (!response.ok || !payload.user) {
        input.setToast(payload.errorMessage ?? "로그인에 실패했습니다.");
        return;
      }
      if (payload.user.id !== userRef.current?.id) {
        commitAuthenticationTransition(payload.user);
      } else {
        userRef.current = payload.user;
        setUser(payload.user);
        commitSessionFreshness(true);
        setSessionError(false);
      }
      if (payload.user.role !== "ADMIN" && isCompactReservationView()) {
        input.setSidebarOpen(false);
      }
      input.setToast(payload.user.role === "ADMIN" ? "관리자 화면을 불러옵니다." : `${payload.user.name}님, 예약 준비 완료`);
    } catch {
      input.setToast(NETWORK_ERROR_MESSAGE);
    } finally {
      input.setLoading(false);
    }
  }, [commitAuthenticationTransition, commitSessionFreshness, input]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      const response = await csrfFetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        input.setToast((await readApiErrorMessage(response)) ?? "로그아웃에 실패했습니다.");
        return;
      }
      commitAuthenticationTransition(null);
      input.setToast("로그아웃되었습니다.");
    } catch {
      input.setToast(NETWORK_ERROR_MESSAGE);
    }
  }, [commitAuthenticationTransition, input.setToast]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  return {
    authenticationGeneration,
    closeProfile,
    getAuthenticationOwner,
    getSessionFreshness,
    login,
    logout,
    openProfile,
    profileOpen,
    profileState,
    refreshMe,
    refreshProfile,
    sessionError,
    sessionFresh,
    user
  };
}

function assertNever(value: never): never {
  throw new UnreachableStudentSessionVariantError(String(value));
}

class UnreachableStudentSessionVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled student session variant: ${value}`);
    this.name = "UnreachableStudentSessionVariantError";
  }
}
