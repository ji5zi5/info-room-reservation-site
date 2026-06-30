import type { CsrfTokenRecord, CsrfTokenStore } from "./csrf";
import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";

export const prismaCsrfTokenStore: CsrfTokenStore = {
  async create(record: CsrfTokenRecord): Promise<void> {
    await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: async (transaction) => {
        await transaction.csrfToken.create({
          data: {
            expiresAt: record.expiresAt,
            sessionId: record.sessionId,
            tokenHash: record.tokenHash
          }
        });
      }
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
