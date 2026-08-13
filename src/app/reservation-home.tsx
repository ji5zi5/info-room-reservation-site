"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getAdvanceReservationPolicy, isSelectableAdvanceDate } from "@/lib/advance-reservation-policy";
import { collectStudentCurrentReservations, type StudentCurrentReservation } from "@/lib/student-reservation-status";
import { AdminConsole } from "./admin/admin-console";
import { consumeAdminRedirectMessage } from "./reservation-home-helpers";
import { useReservationPeriodRefresh } from "./reservation-home-period-refresh";
import type { ReservationActionAuthorization } from "./reservation-home-period-contracts";
import { ReservationHomeView, type ReservationHomeTab } from "./reservation-home-view";
import { isCompactReservationView } from "./reservation-viewport";
import { useStudentReservationActions } from "./use-student-reservation-actions";
import { useStudentSessionProfileResource } from "./use-student-session-profile-resource";

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;

export function ReservationHomePage(): React.ReactElement {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<ReservationHomeTab>("today");
  const [advancePolicy, setAdvancePolicy] = useState<AdvanceReservationPolicy | null>(null);
  const [advanceDate, setAdvanceDate] = useState("");
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedCurrentReservationId, setSelectedCurrentReservationId] = useState<string | null>(null);
  const clearPeriodsRef = useRef<() => void>(() => undefined);
  const clearPendingActionRef = useRef<() => void>(() => undefined);
  const {
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
  } = useStudentSessionProfileResource({
    clearPendingActionRef,
    clearPeriodsRef,
    id,
    password,
    setLoading,
    setSidebarOpen,
    setToast
  });
  const isAdmin = user?.role === "ADMIN";
  const advanceUnavailable = tab === "advance" && advancePolicy?.kind === "unavailable";
  const todayDate = advancePolicy?.today ?? "";
  const targetDate = tab === "advance" ? advanceDate : todayDate;
  const {
    calendarPeriodsByDate,
    clearPeriods,
    getPeriodFreshness,
    lastRefreshedAt,
    periodError,
    periodFresh,
    periods,
    periodsRefreshing,
    refreshPeriodWeek,
    refreshPeriods
  } = useReservationPeriodRefresh({
    advancePolicy,
    advanceUnavailable,
    getAuthenticationOwner,
    refreshMe,
    targetDate,
    user
  });
  clearPeriodsRef.current = clearPeriods;
  const getReservationActionAuthorization = useCallback((): ReservationActionAuthorization => ({
    ...getAuthenticationOwner(),
    periodFresh: getPeriodFreshness(),
    sessionFresh: getSessionFreshness()
  }), [getAuthenticationOwner, getPeriodFreshness, getSessionFreshness]);
  const {
    clearPendingAction,
    confirmPendingAction,
    pendingAction,
    requestCancel,
    requestReserve,
    reservationSubmitting
  } = useStudentReservationActions({
    clearPendingActionRef,
    getReservationActionAuthorization,
    periods,
    profileOpen,
    refreshMe,
    refreshPeriods,
    refreshProfile,
    setLoading,
    setToast,
    targetDate,
    user
  });
  const resourcesFresh = sessionFresh && periodFresh;
  const currentReservations = collectStudentCurrentReservations(calendarPeriodsByDate);

  useEffect(() => {
    const adminMessage = consumeAdminRedirectMessage();
    if (adminMessage) {
      setToast(adminMessage);
    }
  }, []);

  useEffect(() => {
    const policy = getAdvanceReservationPolicy(new Date());
    setAdvancePolicy(policy);
    setAdvanceDate(policy.kind === "available" ? policy.minDate : policy.today);
  }, []);

  useEffect(() => {
    if (user && user.role !== "ADMIN" && isCompactReservationView()) {
      setSidebarOpen(false);
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (
      selectedCurrentReservationId !== null &&
      !currentReservations.some((reservation) => reservation.reservationId === selectedCurrentReservationId)
    ) {
      setSelectedCurrentReservationId(null);
    }
  }, [currentReservations, selectedCurrentReservationId]);

  function showReservationDate(date: string): void {
    if (!advancePolicy) {
      return;
    }
    if (date === advancePolicy.today) {
      setTab("today");
      return;
    }
    if (isSelectableAdvanceDate(date, advancePolicy)) {
      setAdvanceDate(date);
      setTab("advance");
    }
  }

  function selectCalendarDate(date: string): void {
    setSelectedCurrentReservationId(null);
    showReservationDate(date);
  }

  function selectCurrentReservation(reservation: StudentCurrentReservation): void {
    setSelectedCurrentReservationId(reservation.reservationId);
    showReservationDate(reservation.date);
  }

  function retryRefresh(): void {
    void Promise.all([refreshMe(), refreshPeriodWeek()]);
  }

  if (isAdmin) {
    return <AdminConsole />;
  }

  return (
    <ReservationHomeView
      authenticationGeneration={authenticationGeneration}
      advancePolicy={advancePolicy}
      advanceUnavailable={advanceUnavailable}
      currentReservations={currentReservations}
      id={id}
      lastRefreshedAt={lastRefreshedAt}
      loading={loading}
      password={password}
      pendingAction={pendingAction}
      periods={periods}
      periodsRefreshing={periodsRefreshing}
      profileState={profileState}
      refreshError={sessionError || periodError}
      resourcesFresh={resourcesFresh}
      reservationSubmitting={reservationSubmitting}
      selectedCurrentReservationId={selectedCurrentReservationId}
      sidebarOpen={sidebarOpen}
      tab={tab}
      targetDate={targetDate}
      toast={toast}
      user={user}
      onCancel={requestCancel}
      onClosePendingAction={clearPendingAction}
      onCloseProfile={closeProfile}
      onConfirmPendingAction={confirmPendingAction}
      onIdChange={setId}
      onLogin={() => void login()}
      onLogout={() => void logout()}
      onOpenProfile={openProfile}
      onPasswordChange={setPassword}
      onProfileRetry={() => void refreshProfile()}
      onRefreshRetry={retryRefresh}
      onReserve={(studyPeriod) => void requestReserve(studyPeriod)}
      onSelectCalendarDate={selectCalendarDate}
      onSelectCurrentReservation={selectCurrentReservation}
      onSidebarToggle={() => setSidebarOpen((open) => !open)}
      onTabChange={setTab}
    />
  );
}
