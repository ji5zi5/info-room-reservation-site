import type { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

export const withDiscordReservationMessageSystemContext = <TResult>(
  operation: (transaction: Prisma.TransactionClient) => Promise<TResult>
): Promise<TResult> => withDatabaseContext({ actor: systemDatabaseActor(), client: prisma, operation });
