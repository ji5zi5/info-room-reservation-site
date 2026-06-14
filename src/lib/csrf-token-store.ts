import type { CsrfTokenRecord, CsrfTokenStore } from "./csrf";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import { prismaCsrfTokenStore } from "./prisma-csrf-store";

declare global {
  var __infoRoomMockCsrfTokenRecords: Map<string, CsrfTokenRecord> | undefined;
}

const mockCsrfTokenRecords = getMockCsrfTokenRecords();

const noDatabaseMockCsrfTokenStore: CsrfTokenStore = {
  async create(record: CsrfTokenRecord): Promise<void> {
    mockCsrfTokenRecords.set(record.tokenHash, copyCsrfTokenRecord(record));
  },

  async findByHash(tokenHash: string): Promise<CsrfTokenRecord | null> {
    const record = mockCsrfTokenRecords.get(tokenHash);
    return record ? copyCsrfTokenRecord(record) : null;
  }
};

export function getCsrfTokenStore(): CsrfTokenStore {
  return isNoDatabaseMockMode() ? noDatabaseMockCsrfTokenStore : prismaCsrfTokenStore;
}

export function resetMockCsrfTokenStoreForTests(): void {
  mockCsrfTokenRecords.clear();
}

function copyCsrfTokenRecord(record: CsrfTokenRecord): CsrfTokenRecord {
  return {
    expiresAt: new Date(record.expiresAt),
    sessionId: record.sessionId,
    tokenHash: record.tokenHash
  };
}

function getMockCsrfTokenRecords(): Map<string, CsrfTokenRecord> {
  globalThis.__infoRoomMockCsrfTokenRecords ??= new Map<string, CsrfTokenRecord>();
  return globalThis.__infoRoomMockCsrfTokenRecords;
}
