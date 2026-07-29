DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'info_room_runtime') THEN
    CREATE ROLE info_room_runtime
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE postgres TO info_room_runtime;
GRANT USAGE ON SCHEMA public, app_private TO info_room_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO info_room_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO info_room_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_private TO info_room_runtime;

REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM info_room_runtime;

CREATE POLICY "user_runtime_all"
ON "User" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "session_runtime_all"
ON "Session" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "csrf_token_runtime_all"
ON "CsrfToken" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "period_setting_runtime_all"
ON "PeriodSetting" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "notification_delivery_runtime_all"
ON "NotificationDelivery" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "operational_job_runtime_all"
ON "OperationalJob" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "notification_setting_runtime_all"
ON "NotificationSetting" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "retention_policy_runtime_all"
ON "RetentionPolicy" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "rate_limit_bucket_runtime_all"
ON "RateLimitBucket" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "reservation_runtime_all"
ON "Reservation" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "admin_action_runtime_all"
ON "AdminAction" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "user_sanction_runtime_all"
ON "UserSanction" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);
CREATE POLICY "audit_log_runtime_all"
ON "AuditLog" FOR ALL TO info_room_runtime USING (true) WITH CHECK (true);

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO info_room_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO info_room_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app_private
  GRANT EXECUTE ON FUNCTIONS TO info_room_runtime;
