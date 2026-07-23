ALTER TABLE "User"
ADD COLUMN "departedAt" TIMESTAMP(3),
ADD COLUMN "anonymizedAt" TIMESTAMP(3);

CREATE INDEX "User_departedAt_anonymizedAt_idx"
ON "User"("departedAt", "anonymizedAt");

CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" TEXT NOT NULL DEFAULT 'unapproved',
    "reservationReasonDays" INTEGER,
    "adminDetailDays" INTEGER,
    "sanctionReasonDays" INTEGER,
    "auditDetailDays" INTEGER,
    "departedUserIdentityDays" INTEGER,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RetentionPolicy_reservationReasonDays_check"
      CHECK ("reservationReasonDays" IS NULL OR "reservationReasonDays" BETWEEN 1 AND 3650),
    CONSTRAINT "RetentionPolicy_adminDetailDays_check"
      CHECK ("adminDetailDays" IS NULL OR "adminDetailDays" BETWEEN 1 AND 3650),
    CONSTRAINT "RetentionPolicy_sanctionReasonDays_check"
      CHECK ("sanctionReasonDays" IS NULL OR "sanctionReasonDays" BETWEEN 1 AND 3650),
    CONSTRAINT "RetentionPolicy_auditDetailDays_check"
      CHECK ("auditDetailDays" IS NULL OR "auditDetailDays" BETWEEN 1 AND 3650),
    CONSTRAINT "RetentionPolicy_departedUserIdentityDays_check"
      CHECK ("departedUserIdentityDays" IS NULL OR "departedUserIdentityDays" BETWEEN 1 AND 3650)
);

ALTER TABLE "RetentionPolicy" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "retention_policy_admin_system_all"
ON "RetentionPolicy"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());
