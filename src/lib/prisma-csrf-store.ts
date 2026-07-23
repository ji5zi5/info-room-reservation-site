import { MAX_CSRF_TOKENS_PER_SESSION, type CsrfTokenRecord, type CsrfTokenStore } from "./csrf";
import { prisma } from "./db";
import {
  acquireDatabaseMutationLocks,
  PRISMA_LOCKED_MUTATION_TRANSACTION_OPTIONS,
  systemDatabaseActor,
  withDatabaseContext
} from "./db-context";

export const prismaCsrfTokenStore: CsrfTokenStore = {
  async create(record: CsrfTokenRecord): Promise<void> {
    await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: async (transaction): Promise<void> => {
        await acquireDatabaseMutationLocks(transaction, [`csrf-session:${record.sessionId}`]);
        await transaction.csrfToken.create({
          data: {
            expiresAt: record.expiresAt,
            sessionId: record.sessionId,
            tokenHash: record.tokenHash
          }
        });
        const retainedTokens = await transaction.csrfToken.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
          take: MAX_CSRF_TOKENS_PER_SESSION,
          where: { sessionId: record.sessionId }
        });
        await transaction.csrfToken.deleteMany({
          where: {
            id: { notIn: retainedTokens.map((token) => token.id) },
            sessionId: record.sessionId
          }
        });
      },
      options: PRISMA_LOCKED_MUTATION_TRANSACTION_OPTIONS
    });
  },

  async findByHash(tokenHash: string): Promise<CsrfTokenRecord | null> {
    const record = await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: (transaction) => transaction.csrfToken.findUnique({ where: { tokenHash } })
    });
    return record
      ? {
          expiresAt: record.expiresAt,
          sessionId: record.sessionId,
          tokenHash: record.tokenHash
        }
      : null;
  }
};
