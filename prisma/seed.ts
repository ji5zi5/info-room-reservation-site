import { PrismaClient } from "@prisma/client";

import { addDays, toKstDate } from "../src/lib/date";
import { DEFAULT_PERIOD_CAPACITY, STUDY_PERIODS } from "../src/lib/study-periods";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const today = toKstDate(new Date());
  const dates = [today, addDays(today, 1)] as const;

  for (const date of dates) {
    for (const studyPeriod of STUDY_PERIODS) {
      await prisma.periodSetting.upsert({
        create: {
          capacity: DEFAULT_PERIOD_CAPACITY,
          closeTime: "23:00",
          date,
          enabled: true,
          openTime: "08:00",
          studyPeriod
        },
        update: {
          capacity: DEFAULT_PERIOD_CAPACITY,
          closeTime: "23:00",
          enabled: true,
          openTime: "08:00"
        },
        where: {
          date_studyPeriod: {
            date,
            studyPeriod
          }
        }
      });
    }
  }
}

void main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    await prisma.$disconnect();
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unknown seed error");
    }
    process.exitCode = 1;
  });
