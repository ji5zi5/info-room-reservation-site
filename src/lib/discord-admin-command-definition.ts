// allow: SIZE_OK — Discord command registration is a declarative API table.

type DiscordCommandChoice = { readonly name: string; readonly value: string };
type DiscordCommandOption = {
  readonly choices?: readonly DiscordCommandChoice[];
  readonly description: string;
  readonly max_value?: number;
  readonly min_value?: number;
  readonly name: string;
  readonly options?: readonly DiscordCommandOption[];
  readonly required?: boolean;
  readonly type: 1 | 2 | 3 | 4 | 5;
};

export type DiscordApplicationCommandDefinition = {
  readonly description: string;
  readonly dm_permission: false;
  readonly name: DiscordAdminCommandName;
  readonly options: readonly DiscordCommandOption[];
  readonly type: 1;
};

export const DISCORD_ADMIN_COMMAND_NAMES = ["현황", "명단", "예약", "학생", "설정", "알림", "운영"] as const;
export type DiscordAdminCommandName = (typeof DISCORD_ADMIN_COMMAND_NAMES)[number];

const periodChoices = [
  { name: "8면학", value: "EIGHTH" },
  { name: "1면학", value: "FIRST" }
] as const;
const scopeChoices = [
  { name: "전체 날짜", value: "ALL" },
  { name: "특정 날짜", value: "DATE" }
] as const;
const dateOption = { description: "YYYY-MM-DD, 생략 시 오늘", name: "날짜", required: false, type: 3 } as const;
const requiredDateOption = { ...dateOption, description: "YYYY-MM-DD", required: true } as const;
const periodOption = { choices: periodChoices, description: "운영 시간대", name: "시간대", required: true, type: 3 } as const;
const studentOption = { description: "학생 학번", name: "학번", required: true, type: 3 } as const;
const scopeOption = { choices: scopeChoices, description: "전체 또는 날짜별 적용", name: "범위", required: true, type: 3 } as const;
const settingDateOption = { description: "범위가 특정 날짜일 때 YYYY-MM-DD", name: "날짜", required: false, type: 3 } as const;
const enabledOption = { description: "사용 여부", name: "사용", required: true, type: 5 } as const;

export const discordAdminCommandDefinitions: readonly DiscordApplicationCommandDefinition[] = [
  {
    description: "예약과 운영 상태 확인",
    dm_permission: false,
    name: "현황",
    options: [dateOption],
    type: 1
  },
  {
    description: "신청자 명단 확인",
    dm_permission: false,
    name: "명단",
    options: [{ ...dateOption }, { ...periodOption, required: false }],
    type: 1
  },
  {
    description: "예약 추가와 취소",
    dm_permission: false,
    name: "예약",
    options: [
        {
          description: "학생 예약 추가",
          name: "추가",
          options: [
            studentOption,
            requiredDateOption,
            periodOption,
            { description: "학생 신청 사유", name: "신청사유", required: true, type: 3 }
          ],
          type: 1
        },
        {
          description: "학생 예약 취소",
          name: "취소",
          options: [studentOption, requiredDateOption, periodOption],
          type: 1
        },
        {
          description: "시간대의 확정 예약 전체 취소",
          name: "일괄취소",
          options: [requiredDateOption, periodOption],
          type: 1
        }
      ],
    type: 1
  },
  {
    description: "학생 조회와 제재",
    dm_permission: false,
    name: "학생",
    options: [
        {
          description: "학번 또는 이름으로 학생 조회",
          name: "조회",
          options: [{ description: "학번 또는 이름", name: "검색어", required: true, type: 3 }],
          type: 1
        },
        {
          description: "학생 예약 일시 제한",
          name: "제한",
          options: [studentOption, { description: "제한 일수", max_value: 365, min_value: 1, name: "일수", required: true, type: 4 }],
          type: 1
        },
        { description: "학생 영구 차단", name: "밴", options: [studentOption], type: 1 },
        {
          description: "학생 블랙리스트 적용",
          name: "블랙",
          options: [
            studentOption,
            {
              choices: [
                { name: "낮음", value: "LOW" },
                { name: "보통", value: "NORMAL" },
                { name: "높음", value: "HIGH" }
              ],
              description: "블랙리스트 강도",
              name: "강도",
              required: true,
              type: 3
            }
          ],
          type: 1
        },
        {
          description: "학생 제재 해제",
          name: "해제",
          options: [
            studentOption,
            {
              choices: [
                { name: "전체", value: "ALL" },
                { name: "일시 제한", value: "RESTRICTION" },
                { name: "영구 차단", value: "BAN" },
                { name: "블랙리스트", value: "BLACKLIST" }
              ],
              description: "해제할 제재",
              name: "종류",
              required: true,
              type: 3
            }
          ],
          type: 1
        }
      ],
    type: 1
  },
  {
    description: "예약 운영 설정",
    dm_permission: false,
    name: "설정",
    options: [
        { description: "적용 중인 설정 조회", name: "조회", options: [dateOption], type: 1 },
        {
          description: "신청 시작과 마감 시각 변경",
          name: "시간",
          options: [
            scopeOption,
            periodOption,
            { description: "HH:mm", name: "시작", required: true, type: 3 },
            { description: "HH:mm", name: "마감", required: true, type: 3 },
            settingDateOption
          ],
          type: 1
        },
        {
          description: "예약 정원 변경",
          name: "정원",
          options: [scopeOption, periodOption, { description: "1~200", max_value: 200, min_value: 1, name: "정원", required: true, type: 4 }, settingDateOption],
          type: 1
        },
        {
          description: "시간대 사용 여부 변경",
          name: "활성",
          options: [scopeOption, periodOption, enabledOption, settingDateOption],
          type: 1
        }
      ],
    type: 1
  },
  {
    description: "Discord 알림 관리",
    dm_permission: false,
    name: "알림",
    options: [
        { description: "알림 설정 확인", name: "상태", type: 1 },
        { description: "신청 알림 변경", name: "신청", options: [enabledOption], type: 1 },
        { description: "마감 명단 알림 변경", name: "마감", options: [enabledOption], type: 1 },
        {
          description: "마감 명단 즉시 전송",
          name: "마감전송",
          options: [requiredDateOption, periodOption, { description: "이미 전송된 명단도 다시 전송", name: "강제", required: false, type: 5 }],
          type: 1
        }
      ],
    type: 1
  },
  {
    description: "Discord 운영 상태와 복구",
    dm_permission: false,
    name: "운영",
    options: [
        { description: "작업 상태 확인", name: "상태", type: 1 },
        { description: "미처리 작업 확인", name: "미처리", type: 1 },
        { description: "운영판 즉시 동기화", name: "동기화", type: 1 }
      ],
    type: 1
  }
];
