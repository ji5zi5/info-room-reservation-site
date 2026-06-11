export const STUDY_PERIODS = ["EIGHTH", "FIRST"] as const;

export type StudyPeriod = (typeof STUDY_PERIODS)[number];

export const DEFAULT_PERIOD_CAPACITY = 10;

export const STUDY_PERIOD_LABELS: Record<StudyPeriod, string> = {
  EIGHTH: "8면학",
  FIRST: "1면학"
};

const STUDY_PERIOD_VALUES: readonly string[] = STUDY_PERIODS;

export function getStudyPeriodLabel(studyPeriod: StudyPeriod): string {
  return STUDY_PERIOD_LABELS[studyPeriod];
}

export function isStudyPeriod(value: string): value is StudyPeriod {
  return STUDY_PERIOD_VALUES.includes(value);
}

export function parseStudyPeriod(value: string): StudyPeriod {
  if (!isStudyPeriod(value)) {
    throw new InvalidStudyPeriodError(value);
  }
  return value;
}

export class InvalidStudyPeriodError extends Error {
  public constructor(value: string) {
    super(`Invalid study period: ${value}`);
    this.name = "InvalidStudyPeriodError";
  }
}
