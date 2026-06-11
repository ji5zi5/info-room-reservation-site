export function toKstDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);

  return `${datePart(parts, "year")}-${datePart(parts, "month")}-${datePart(parts, "day")}`;
}

export function addDays(dateText: string, days: number): string {
  const date = new Date(`${dateText}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return toKstDate(date);
}

function datePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) {
    throw new KstDateFormatError(type);
  }
  return part.value;
}

class KstDateFormatError extends Error {
  public constructor(type: Intl.DateTimeFormatPartTypes) {
    super(`KST date part not found: ${type}`);
    this.name = "KstDateFormatError";
  }
}
