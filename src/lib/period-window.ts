export type PeriodWindowState = "closed" | "not_open_yet" | "open";

export type PeriodWindowSetting = {
  readonly closeTime: string;
  readonly date: string;
  readonly openTime: string;
};

export function getPeriodWindowState(setting: PeriodWindowSetting, now: Date): PeriodWindowState {
  const kst = getKstDateTime(now);
  if (kst.date > setting.date) {
    return "closed";
  }

  const nowMinutes = toMinutes(kst.time);
  if (nowMinutes < toMinutes(setting.openTime)) {
    return "not_open_yet";
  }
  if (nowMinutes > toMinutes(setting.closeTime)) {
    return "closed";
  }
  return "open";
}

export function isPeriodWindowClosed(setting: PeriodWindowSetting, now: Date): boolean {
  return getPeriodWindowState(setting, now) === "closed";
}

function getKstDateTime(date: Date): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);

  const year = getDatePart(parts, "year");
  const month = getDatePart(parts, "month");
  const day = getDatePart(parts, "day");
  const hour = getDatePart(parts, "hour");
  const minute = getDatePart(parts, "minute");

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

function getDatePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) {
    throw new PeriodWindowDateFormatError(type);
  }
  return part.value;
}

function toMinutes(time: string): number {
  const [hourText, minuteText] = time.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  return hour * 60 + minute;
}

class PeriodWindowDateFormatError extends Error {
  public constructor(part: Intl.DateTimeFormatPartTypes) {
    super(`KST date part not found: ${part}`);
    this.name = "PeriodWindowDateFormatError";
  }
}
