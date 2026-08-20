DROP POLICY IF EXISTS "user_runtime_all" ON "User";
DROP POLICY IF EXISTS "session_runtime_all" ON "Session";
DROP POLICY IF EXISTS "csrf_token_runtime_all" ON "CsrfToken";
DROP POLICY IF EXISTS "period_setting_runtime_all" ON "PeriodSetting";
DROP POLICY IF EXISTS "notification_delivery_runtime_all" ON "NotificationDelivery";
DROP POLICY IF EXISTS "operational_job_runtime_all" ON "OperationalJob";
DROP POLICY IF EXISTS "notification_setting_runtime_all" ON "NotificationSetting";
DROP POLICY IF EXISTS "retention_policy_runtime_all" ON "RetentionPolicy";
DROP POLICY IF EXISTS "rate_limit_bucket_runtime_all" ON "RateLimitBucket";
DROP POLICY IF EXISTS "reservation_runtime_all" ON "Reservation";
DROP POLICY IF EXISTS "admin_action_runtime_all" ON "AdminAction";
DROP POLICY IF EXISTS "user_sanction_runtime_all" ON "UserSanction";
DROP POLICY IF EXISTS "audit_log_runtime_all" ON "AuditLog";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'info_room_runtime') THEN
    RAISE EXCEPTION 'info_room_runtime role is required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'info_room_runtime'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'info_room_runtime role has unsafe privileges';
  END IF;
END
$$;
