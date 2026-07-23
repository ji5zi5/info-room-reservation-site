import type { Prisma } from "@prisma/client";

import type { DatabaseActor } from "./db-context";
import type { RetentionCounts, RetentionPolicy } from "./retention-policy";

export async function recordRetentionCleanupForAdmin(
  transaction: Prisma.TransactionClient,
  actor: DatabaseActor,
  ipHash: string,
  policyVersion: string,
  counts: RetentionCounts
): Promise<void> {
  const action = await transaction.adminAction.create({
    data: {
      action: "RETENTION_POLICY_APPLY",
      actorId: actor.id,
      after: JSON.stringify({ counts, policyVersion }),
      ipHash,
      reason: "보존 정책 적용"
    }
  });
  await transaction.auditLog.create({
    data: {
      action: "RETENTION_POLICY_APPLY",
      actorId: actor.id,
      detail: JSON.stringify({ actionId: action.id, counts, policyVersion })
    }
  });
}

export async function recordRetentionCleanupForSystem(
  transaction: Prisma.TransactionClient,
  policyVersion: string,
  counts: RetentionCounts
): Promise<void> {
  if (Object.values(counts).every((count) => count === 0)) {
    return;
  }
  await transaction.auditLog.create({
    data: {
      action: "RETENTION_CLEANUP",
      detail: JSON.stringify({ counts, policyVersion })
    }
  });
}

export async function recordRetentionPolicyChange(
  transaction: Prisma.TransactionClient,
  input: {
    readonly action: "RETENTION_POLICY_DISABLE" | "RETENTION_POLICY_PATCH";
    readonly actor: DatabaseActor;
    readonly after: RetentionPolicy;
    readonly before: RetentionPolicy;
    readonly ipHash: string;
  }
): Promise<void> {
  const action = await transaction.adminAction.create({
    data: {
      action: input.action,
      actorId: input.actor.id,
      after: JSON.stringify(input.after),
      before: JSON.stringify(input.before),
      ipHash: input.ipHash,
      reason: input.action === "RETENTION_POLICY_PATCH" ? "보존 정책 변경" : "보존 정책 비활성화"
    }
  });
  await transaction.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actor.id,
      detail: JSON.stringify({
        actionId: action.id,
        enabled: input.after.enabled,
        policyVersion: input.after.policyVersion
      })
    }
  });
}
