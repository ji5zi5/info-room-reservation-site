import type { CsrfTokenRecord, CsrfTokenStore } from "./csrf";
import { prisma } from "./db";

export const prismaCsrfTokenStore: CsrfTokenStore = {
  async create(record: CsrfTokenRecord): Promise<void> {
    await prisma.csrfToken.create({
      data: {
        expiresAt: record.expiresAt,
        sessionId: record.sessionId,
        tokenHash: record.tokenHash
      }
    });
  },

  async findByHash(tokenHash: string): Promise<CsrfTokenRecord | null> {
    const record = await prisma.csrfToken.findUnique({ where: { tokenHash } });
    return record
      ? {
          expiresAt: record.expiresAt,
          sessionId: record.sessionId,
          tokenHash: record.tokenHash
        }
      : null;
  }
};
