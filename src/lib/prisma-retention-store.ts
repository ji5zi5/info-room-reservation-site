import type { Prisma } from "@prisma/client";

import {
  acquireDatabaseMutationLocks,
  systemDatabaseActor,
  userMutationLockKey,
  withDatabaseContext,
  withDatabaseMutation,
  type DatabaseActor
} from "./db-context";
import { prisma } from "./db";
import { isRetentionPurgeEnabled } from "./env";
import {
  applyRetentionCandidates,
  readRetentionCandidateIds
} from "./prisma-retention-candidates";
import {
  recordRetentionCleanupForAdmin,
  recordRetentionCleanupForSystem,
  recordRetentionPolicyChange
} from "./prisma-retention-audit";
import {
  buildRetentionPreview,
  DEFAULT_RETENTION_POLICY,
  EMPTY_RETENTION_COUNTS,
  missingRetentionApprovalFields,
  normalizeRetentionPolicy,
  type RetentionCleanupResult,
  type RetentionPolicy,
  type RetentionPolicyDraft,
  type RetentionPreview
} from "./retention-policy";

const RETENTION_MUTATION_LOCK_KEY = "retention:global";

type RetentionPreviewResult = {
  readonly policy: RetentionPolicy;
  readonly preview: RetentionPreview;
};

export type RetentionApplyResult =
  | { readonly kind: "applied"; readonly preview: RetentionPreview }
  | { readonly kind: "disabled" }
  | { readonly kind: "not_approved"; readonly missingFields: readonly string[] }
  | { readonly kind: "stale"; readonly preview: RetentionPreview };

export const prismaRetentionStore = {
  async applyApproved(input: {
    readonly actor: DatabaseActor;
    readonly expectedChecksum: string;
    readonly ipHash: string;
    readonly now: Date;
    readonly purgeEnabled?: boolean;
  }): Promise<RetentionApplyResult> {
    if (!purgeEnabled(input.purgeEnabled)) {
      return { kind: "disabled" };
    }
    return withDatabaseMutation({
      actor: input.actor,
      client: prisma,
      lockKeys: [RETENTION_MUTATION_LOCK_KEY],
      operation: async (transaction) => {
        const { candidates, policy, preview } = await previewInTransaction(transaction, input.now);
        const missingFields = missingRetentionApprovalFields(policy);
        if (missingFields.length > 0) {
          return { kind: "not_approved", missingFields } as const;
        }
        if (preview.checksum !== input.expectedChecksum) {
          return { kind: "stale", preview } as const;
        }
        await lockDepartedUsers(transaction, candidates.departedUserIdentities);
        const counts = await applyRetentionCandidates(transaction, candidates, input.now, policy);
        await transaction.retentionPolicy.update({
          data: { enabled: true },
          where: { id: policy.id }
        });
        await recordRetentionCleanupForAdmin(
          transaction,
          input.actor,
          input.ipHash,
          policy.policyVersion,
          counts
        );
        return {
          kind: "applied",
          preview: { ...preview, counts }
        } as const;
      }
    });
  },

  async applyScheduled(input: {
    readonly now: Date;
    readonly purgeEnabled?: boolean;
  }): Promise<RetentionCleanupResult> {
    if (!purgeEnabled(input.purgeEnabled)) {
      return disabledCleanup();
    }
    return withDatabaseMutation({
      actor: systemDatabaseActor(),
      client: prisma,
      lockKeys: [RETENTION_MUTATION_LOCK_KEY],
      operation: async (transaction) => {
        const { candidates, policy } = await previewInTransaction(transaction, input.now);
        if (!policy.enabled) {
          return disabledCleanup(policy.policyVersion);
        }
        if (missingRetentionApprovalFields(policy).length > 0) {
          return {
            counts: EMPTY_RETENTION_COUNTS,
            kind: "unapproved",
            policyVersion: policy.policyVersion
          };
        }
        await lockDepartedUsers(transaction, candidates.departedUserIdentities);
        const counts = await applyRetentionCandidates(transaction, candidates, input.now, policy);
        await recordRetentionCleanupForSystem(transaction, policy.policyVersion, counts);
        return {
          counts,
          kind: "applied",
          policyVersion: policy.policyVersion
        };
      }
    });
  },

  async disable(input: {
    readonly actor: DatabaseActor;
    readonly ipHash: string;
  }): Promise<RetentionPolicy> {
    return withDatabaseMutation({
      actor: input.actor,
      client: prisma,
      lockKeys: [RETENTION_MUTATION_LOCK_KEY],
      operation: async (transaction) => {
        const row = await transaction.retentionPolicy.findUnique({ where: { id: "global" } });
        if (!row) {
          return DEFAULT_RETENTION_POLICY;
        }
        const before = normalizeRetentionPolicy(row);
        const after = normalizeRetentionPolicy(
          await transaction.retentionPolicy.update({
            data: { enabled: false },
            where: { id: before.id }
          })
        );
        await recordRetentionPolicyChange(transaction, {
          action: "RETENTION_POLICY_DISABLE",
          actor: input.actor,
          after,
          before,
          ipHash: input.ipHash
        });
        return after;
      }
    });
  },

  async preview(input: {
    readonly actor: DatabaseActor;
    readonly now: Date;
  }): Promise<RetentionPreviewResult> {
    return withDatabaseContext({
      actor: input.actor,
      client: prisma,
      operation: async (transaction) => {
        const { policy, preview } = await previewInTransaction(transaction, input.now);
        return { policy, preview };
      }
    });
  },

  async save(input: {
    readonly actor: DatabaseActor;
    readonly ipHash: string;
    readonly policy: RetentionPolicyDraft;
  }): Promise<RetentionPolicy> {
    return withDatabaseMutation({
      actor: input.actor,
      client: prisma,
      lockKeys: [RETENTION_MUTATION_LOCK_KEY],
      operation: async (transaction) => {
        const before = normalizeRetentionPolicy(
          await transaction.retentionPolicy.findUnique({ where: { id: "global" } })
        );
        const after = normalizeRetentionPolicy(
          await transaction.retentionPolicy.upsert({
            create: {
              ...input.policy,
              enabled: false,
              id: "global"
            },
            update: {
              ...input.policy,
              enabled: false
            },
            where: { id: "global" }
          })
        );
        await recordRetentionPolicyChange(transaction, {
          action: "RETENTION_POLICY_PATCH",
          actor: input.actor,
          after,
          before,
          ipHash: input.ipHash
        });
        return after;
      }
    });
  }
};

async function previewInTransaction(
  transaction: Prisma.TransactionClient,
  now: Date
): Promise<{
  readonly candidates: Awaited<ReturnType<typeof readRetentionCandidateIds>>;
  readonly policy: RetentionPolicy;
  readonly preview: RetentionPreview;
}> {
  const policy = normalizeRetentionPolicy(
    await transaction.retentionPolicy.findUnique({ where: { id: "global" } })
  );
  const candidates = await readRetentionCandidateIds(transaction, policy, now);
  return {
    candidates,
    policy,
    preview: buildRetentionPreview(policy, candidates)
  };
}

async function lockDepartedUsers(
  transaction: Prisma.TransactionClient,
  userIds: readonly string[]
): Promise<void> {
  await acquireDatabaseMutationLocks(
    transaction,
    userIds.map((userId) => userMutationLockKey(userId))
  );
}

function purgeEnabled(override: boolean | undefined): boolean {
  return override ?? isRetentionPurgeEnabled();
}

function disabledCleanup(
  policyVersion = DEFAULT_RETENTION_POLICY.policyVersion
): RetentionCleanupResult {
  return {
    counts: EMPTY_RETENTION_COUNTS,
    kind: "disabled",
    policyVersion
  };
}
