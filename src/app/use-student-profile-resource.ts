"use client";

import { useCallback, useRef, useState } from "react";

import { NETWORK_ERROR_MESSAGE, readStudentProfilePayload } from "./client-api-response";
import {
  isLatestOwnedResourceRequest,
  type AuthenticationOwner
} from "./reservation-home-period-contracts";
import type { ReservationHomeProfileState } from "./reservation-home-view";
import type { ReservationSidebarUser } from "./reservation-sidebar";

type OwnedProfileState = ReservationHomeProfileState & AuthenticationOwner;

type StudentProfileResourceInput = {
  readonly authenticationGeneration: number;
  readonly getAuthenticationOwner: () => AuthenticationOwner;
  readonly user: ReservationSidebarUser | null;
};

type StudentProfileResource = {
  readonly clearProfile: () => void;
  readonly closeProfile: () => void;
  readonly openProfile: () => void;
  readonly profileOpen: boolean;
  readonly profileState: ReservationHomeProfileState;
  readonly refreshProfile: () => Promise<void>;
};

const EMPTY_PROFILE_STATE: OwnedProfileState = {
  authenticationGeneration: -1,
  errorMessage: null,
  loading: false,
  open: false,
  profile: null,
  userId: null
};

export function useStudentProfileResource(input: StudentProfileResourceInput): StudentProfileResource {
  const profileRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const profileRequestGenerationRef = useRef(0);
  const profileAbortControllerRef = useRef<AbortController | null>(null);
  const [profileState, setProfileState] = useState<OwnedProfileState>(EMPTY_PROFILE_STATE);

  const clearProfile = useCallback((): void => {
    profileRequestGenerationRef.current += 1;
    profileAbortControllerRef.current?.abort();
    profileAbortControllerRef.current = null;
    profileRefreshPromiseRef.current = null;
    setProfileState(EMPTY_PROFILE_STATE);
  }, []);

  const refreshProfile = useCallback(async (): Promise<void> => {
    const owner = input.getAuthenticationOwner();
    if (owner.userId === null) {
      return;
    }
    const requestGeneration = profileRequestGenerationRef.current + 1;
    profileRequestGenerationRef.current = requestGeneration;
    profileAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    profileAbortControllerRef.current = abortController;
    const refresh = (async (): Promise<void> => {
      setProfileState((current) => ({
        ...current,
        ...owner,
        errorMessage: null,
        loading: true,
        profile: null
      }));
      try {
        const result = await readStudentProfilePayload(
          await fetch("/api/me/profile", { signal: abortController.signal })
        );
        const request = { ...owner, requestGeneration };
        if (!isLatestOwnedResourceRequest(request, input.getAuthenticationOwner(), profileRequestGenerationRef.current)) {
          return;
        }
        switch (result.kind) {
          case "loaded":
            setProfileState((current) => ({ ...current, errorMessage: null, loading: false, profile: result.profile }));
            return;
          case "error":
            setProfileState((current) => ({ ...current, errorMessage: result.message, loading: false, profile: null }));
            return;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        const request = { ...owner, requestGeneration };
        if (!isLatestOwnedResourceRequest(request, input.getAuthenticationOwner(), profileRequestGenerationRef.current)) {
          return;
        }
        setProfileState((current) => ({
          ...current,
          errorMessage: NETWORK_ERROR_MESSAGE,
          loading: false,
          profile: null
        }));
      }
    })();
    profileRefreshPromiseRef.current = refresh;
    try {
      await refresh;
    } finally {
      if (profileRefreshPromiseRef.current === refresh) {
        profileRefreshPromiseRef.current = null;
      }
      if (profileAbortControllerRef.current === abortController) {
        profileAbortControllerRef.current = null;
      }
    }
  }, [input.getAuthenticationOwner]);

  const openProfile = useCallback((): void => {
    const owner = input.getAuthenticationOwner();
    setProfileState((current) => ({ ...current, ...owner, open: true }));
    void refreshProfile();
  }, [input.getAuthenticationOwner, refreshProfile]);

  const closeProfile = useCallback((): void => {
    setProfileState((current) => ({ ...current, open: false }));
  }, []);

  const visibleProfileState =
    profileState.authenticationGeneration === input.authenticationGeneration &&
    profileState.userId === (input.user?.id ?? null)
      ? profileState
      : {
          ...EMPTY_PROFILE_STATE,
          authenticationGeneration: input.authenticationGeneration,
          open: profileState.open,
          userId: input.user?.id ?? null
        };

  return {
    clearProfile,
    closeProfile,
    openProfile,
    profileOpen: profileState.open,
    profileState: visibleProfileState,
    refreshProfile
  };
}
