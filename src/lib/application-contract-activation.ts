import { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { DISCORD_OPERATIONS_APPLICATION_CONTRACT, resolveDeploymentSha } from "./db-context";

const READINESS_DIGEST = "c99eebbeec6b76f35bce411575d3f03614703fa528d27964cce6989b5356e2b4";
const DeploymentShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const MarkerRowsSchema = z.tuple([z.object({ activatedAt: z.coerce.date().nullable() }).strict()]);
const ReceiptRowsSchema = z.tuple([z.object({ receiptId: z.string().min(1) }).strict()]);

export const APPLICATION_CONTRACT_ACTIVATION_SOURCES = ["FIRST_CRON", "ADMIN"] as const;
export type ApplicationContractActivationSource = (typeof APPLICATION_CONTRACT_ACTIVATION_SOURCES)[number];

export type ApplicationContractActivationTransaction = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
  readonly $queryRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
};

export type ApplicationContractActivationClient = {
  readonly $transaction: <TResult>(
    operation: (transaction: ApplicationContractActivationTransaction) => Promise<TResult>
  ) => Promise<TResult>;
};

export type ApplicationContractActivationResult = {
  readonly deploymentSha: string;
  readonly kind: "activated" | "already_active";
  readonly source: ApplicationContractActivationSource;
};

type ActivationInput = {
  readonly client?: ApplicationContractActivationClient;
  readonly source: ApplicationContractActivationSource;
};

export class ApplicationContractActivationError extends Error {
  public readonly code: "DEPLOYMENT_SHA_INVALID" | "READINESS_RECEIPT_INVALID";

  public constructor(code: ApplicationContractActivationError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ApplicationContractActivationError";
  }
}

export async function activateApplicationContract(input: ActivationInput): Promise<ApplicationContractActivationResult> {
  const deploymentSha = DeploymentShaSchema.safeParse(resolveDeploymentSha());
  if (!deploymentSha.success) {
    throw new ApplicationContractActivationError(
      "DEPLOYMENT_SHA_INVALID",
      "Application contract activation requires a full 40-character deployment SHA"
    );
  }
  const client = input.client ?? activationClient();
  const marker = await readActivationMarker(client, deploymentSha.data);
  if (marker.activatedAt !== null) {
    return { deploymentSha: deploymentSha.data, kind: "already_active", source: input.source };
  }

  let receiptId: string;
  try {
    receiptId = await client.$transaction(async (transaction) => {
      await setActivationContext(transaction, deploymentSha.data);
      const rows = await transaction.$queryRaw`
        SELECT app_private.record_application_readiness(
          ${deploymentSha.data}, ${READINESS_DIGEST}, ${input.source}
        ) AS "receiptId"
      `;
      const parsed = ReceiptRowsSchema.safeParse(rows);
      if (!parsed.success) {
        throw new ApplicationContractActivationError(
          "READINESS_RECEIPT_INVALID",
          "Database readiness did not return exactly one server-side receipt"
        );
      }
      return parsed.data[0].receiptId;
    });
  } catch (error) {
    const concurrentMarker = await readActivationMarker(client, deploymentSha.data);
    if (concurrentMarker.activatedAt !== null) {
      return { deploymentSha: deploymentSha.data, kind: "already_active", source: input.source };
    }
    throw error;
  }

  try {
    await client.$transaction(async (transaction) => {
      await setActivationContext(transaction, deploymentSha.data);
      await transaction.$executeRaw`SELECT set_config('app.activation_source', ${input.source}, true)`;
      await transaction.$queryRaw`
        SELECT app_private.activate_application_contract(
          ${deploymentSha.data}, ${receiptId}, ${input.source}
        )::text AS "activation"
      `;
    });
  } catch (error) {
    const concurrentMarker = await readActivationMarker(client, deploymentSha.data);
    if (concurrentMarker.activatedAt !== null) {
      return { deploymentSha: deploymentSha.data, kind: "already_active", source: input.source };
    }
    throw error;
  }
  return { deploymentSha: deploymentSha.data, kind: "activated", source: input.source };
}

async function readActivationMarker(
  client: ApplicationContractActivationClient,
  deploymentSha: string
): Promise<z.infer<typeof MarkerRowsSchema>[number]> {
  return client.$transaction(async (transaction) => {
    await setActivationContext(transaction, deploymentSha);
    const rows = await transaction.$queryRaw`
      SELECT "activatedAt" FROM "SchemaCompatibility" WHERE "id" = 'discord-operations'
    `;
    return MarkerRowsSchema.parse(rows)[0];
  });
}

async function setActivationContext(
  transaction: ApplicationContractActivationTransaction,
  deploymentSha: string
): Promise<void> {
  await transaction.$executeRaw`
    SELECT set_config('app.application_contract', ${DISCORD_OPERATIONS_APPLICATION_CONTRACT}, true)
  `;
  await transaction.$executeRaw`SELECT set_config('app.deployment_sha', ${deploymentSha}, true)`;
  await transaction.$executeRaw`SELECT set_config('app.current_user_role', 'SYSTEM', true)`;
}

let directActivationClient: PrismaClient | undefined;

function activationClient(): ApplicationContractActivationClient {
  if (directActivationClient !== undefined) return directActivationClient;
  const directUrl = process.env.DIRECT_URL;
  directActivationClient = directUrl === undefined
    ? new PrismaClient()
    : new PrismaClient({ datasources: { db: { url: directUrl } } });
  return directActivationClient;
}
