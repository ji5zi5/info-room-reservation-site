import { parseAdminReservationStatus } from "@/lib/admin-reservations";

import type { AdminReservationStatusFilter } from "./admin-types";

const CONTROLLED_RESERVATION_DEEP_LINK_KEYS = ["section", "date", "status", "reservation"] as const;
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
const ADMIN_CONSOLE_LINK_VERSION = 1;
const CONTROLLED_EXACT_LINK_KEYS = ["section", "reservation", "user", "action"] as const;

export type AdminConsoleDeepLinkTarget =
  | { readonly kind: "reservation"; readonly reservationId: string }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly actionId: string; readonly kind: "audit" };

export type ParsedAdminConsoleDeepLink =
  | { readonly kind: "absent" }
  | { readonly cleanedSearch: string; readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly target: AdminConsoleDeepLinkTarget; readonly version: 1 };

export type AdminConsoleDeepLinkResolution =
  | { readonly kind: "absent" }
  | { readonly cleanedSearch: string; readonly kind: "invalid" | "missing" }
  | { readonly cleanedSearch: string; readonly kind: "found"; readonly target: AdminConsoleDeepLinkTarget };

export function parseAdminConsoleDeepLink(search: string): ParsedAdminConsoleDeepLink {
  const parameters = new URLSearchParams(search);
  if (!CONTROLLED_EXACT_LINK_KEYS.some((key) => parameters.has(key))) {
    return { kind: "absent" };
  }
  const section = singleValue(parameters, "section");
  const reservationId = singleValue(parameters, "reservation");
  const userId = singleValue(parameters, "user");
  const actionId = singleValue(parameters, "action");
  const target = section === "reservations" && validExactId(reservationId) && userId === null && actionId === null
    ? { kind: "reservation", reservationId } as const
    : section === "students" && validExactId(userId) && reservationId === null && actionId === null
      ? { kind: "user", userId } as const
      : section === "audit" && validExactId(actionId) && reservationId === null && userId === null
        ? { actionId, kind: "audit" } as const
        : null;
  return target === null
    ? { cleanedSearch: removeControlledExactLinkKeys(parameters), kind: "invalid" }
    : { kind: "valid", target, version: ADMIN_CONSOLE_LINK_VERSION };
}

export function writeAdminConsoleDeepLink(search: string, target: AdminConsoleDeepLinkTarget): string {
  const parameters = new URLSearchParams(search);
  removeControlledExactLinkKeys(parameters);
  switch (target.kind) {
    case "reservation":
      if (!validExactId(target.reservationId)) return parameters.toString();
      parameters.set("section", "reservations");
      parameters.set("reservation", target.reservationId);
      break;
    case "user":
      if (!validExactId(target.userId)) return parameters.toString();
      parameters.set("section", "students");
      parameters.set("user", target.userId);
      break;
    case "audit":
      if (!validExactId(target.actionId)) return parameters.toString();
      parameters.set("section", "audit");
      parameters.set("action", target.actionId);
      break;
  }
  return parameters.toString();
}

export function resolveAdminConsoleDeepLink(
  search: string,
  findExactTarget: (target: AdminConsoleDeepLinkTarget) => boolean
): AdminConsoleDeepLinkResolution {
  const parsed = parseAdminConsoleDeepLink(search);
  if (parsed.kind !== "valid") {
    return parsed;
  }
  const parameters = new URLSearchParams(search);
  const cleanedSearch = removeControlledExactLinkKeys(parameters);
  return findExactTarget(parsed.target)
    ? { cleanedSearch, kind: "found", target: parsed.target }
    : { cleanedSearch, kind: "missing" };
}

export type DeepLinkTarget = {
  readonly date: string;
  readonly reservationId: string;
};

export type ParsedDeepLink =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly cleanedSearch: string }
  | { readonly kind: "valid"; readonly target: DeepLinkTarget };

export type ReservationDeepLinkResolution =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly cleanedSearch: string }
  | { readonly kind: "missing"; readonly cleanedSearch: string }
  | { readonly kind: "found"; readonly cleanedSearch: string; readonly target: DeepLinkTarget };

export function readReservationStatusFromLocation(location: Location): AdminReservationStatusFilter {
  return parseAdminReservationStatus(new URLSearchParams(location.search).get("status"));
}

export function writeReservationStatusToHistory(location: Location, history: History, status: AdminReservationStatusFilter): void {
  const url = new URL(location.href);
  url.searchParams.set("status", status);
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export function parseReservationDeepLink(search: string): ParsedDeepLink {
  const parameters = new URLSearchParams(search);
  if (!CONTROLLED_RESERVATION_DEEP_LINK_KEYS.some((key) => parameters.has(key))) {
    return { kind: "absent" };
  }

  const section = parameters.getAll("section");
  const dates = parameters.getAll("date");
  const statuses = parameters.getAll("status");
  const reservationIds = parameters.getAll("reservation");
  const date = dates[0];
  const reservationId = reservationIds[0];
  if (
    section.length !== 1 ||
    section[0] !== "reservations" ||
    date === undefined ||
    dates.length !== 1 ||
    !isCalendarDate(date) ||
    statuses.length !== 1 ||
    statuses[0] !== "CONFIRMED" ||
    reservationId === undefined ||
    reservationIds.length !== 1 ||
    !RESERVATION_ID_PATTERN.test(reservationId)
  ) {
    return { kind: "invalid", cleanedSearch: removeControlledReservationDeepLinkKeys(parameters) };
  }

  return { kind: "valid", target: { date, reservationId } };
}

export function writeReservationDeepLink(search: string, target: DeepLinkTarget): string {
  const parameters = new URLSearchParams(search);
  removeControlledReservationDeepLinkKeys(parameters);
  if (!isDeepLinkTarget(target)) {
    return parameters.toString();
  }
  parameters.set("section", "reservations");
  parameters.set("date", target.date);
  parameters.set("status", "CONFIRMED");
  parameters.set("reservation", target.reservationId);
  return parameters.toString();
}

export function resolveReservationDeepLink(
  search: string,
  findConfirmedReservation: (target: DeepLinkTarget) => boolean
): ReservationDeepLinkResolution {
  const parsed = parseReservationDeepLink(search);
  switch (parsed.kind) {
    case "absent":
    case "invalid":
      return parsed;
    case "valid": {
      const parameters = new URLSearchParams(search);
      parameters.delete("reservation");
      return findConfirmedReservation(parsed.target)
        ? { kind: "found", cleanedSearch: parameters.toString(), target: parsed.target }
        : { kind: "missing", cleanedSearch: parameters.toString() };
    }
  }
}

export function buildAdminReservationDeepLinkUrl(appOrigin: string, target: DeepLinkTarget): string {
  const url = new URL("/", appOrigin);
  url.search = writeReservationDeepLink("", target);
  return url.toString();
}

export function replaceReservationDeepLinkSearch(location: Location, history: History, search: string): void {
  const query = search ? `?${search}` : "";
  history.replaceState(null, "", `${location.pathname}${query}${location.hash}`);
}

function removeControlledReservationDeepLinkKeys(parameters: URLSearchParams): string {
  for (const key of CONTROLLED_RESERVATION_DEEP_LINK_KEYS) {
    parameters.delete(key);
  }
  return parameters.toString();
}

function removeControlledExactLinkKeys(parameters: URLSearchParams): string {
  for (const key of CONTROLLED_EXACT_LINK_KEYS) {
    parameters.delete(key);
  }
  return parameters.toString();
}

function singleValue(parameters: URLSearchParams, key: string): string | null {
  const values = parameters.getAll(key);
  return values.length === 1 ? values[0] ?? null : null;
}

function validExactId(value: string | null): value is string {
  return value !== null && RESERVATION_ID_PATTERN.test(value);
}

function isDeepLinkTarget(target: DeepLinkTarget): boolean {
  return isCalendarDate(target.date) && RESERVATION_ID_PATTERN.test(target.reservationId);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = month === 2
    ? isLeapYear(year) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
