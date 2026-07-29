ALTER TABLE "OperationalJob" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operational_job_admin_system_all"
ON "OperationalJob"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prisma_migrations_deny_all"
ON "_prisma_migrations"
FOR ALL
USING (false)
WITH CHECK (false);
