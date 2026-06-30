CREATE SCHEMA IF NOT EXISTS app_private;

GRANT USAGE ON SCHEMA app_private TO PUBLIC;

CREATE OR REPLACE FUNCTION app_private.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_private.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_user_role', true), '')
$$;

CREATE OR REPLACE FUNCTION app_private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_private.current_user_role() = 'ADMIN'
$$;

CREATE OR REPLACE FUNCTION app_private.is_system()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_private.current_user_role() = 'SYSTEM'
$$;

CREATE OR REPLACE FUNCTION app_private.is_admin_or_system()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_private.is_admin() OR app_private.is_system()
$$;

CREATE OR REPLACE FUNCTION app_private.can_access_user(user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT app_private.is_admin_or_system() OR app_private.current_user_id() = user_id
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_private TO PUBLIC;

ALTER TABLE "AdminAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CsrfToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PeriodSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RateLimitBucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserSanction" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_select_self_admin_system"
ON "User"
FOR SELECT
USING (app_private.can_access_user("id"));

CREATE POLICY "user_insert_admin_system"
ON "User"
FOR INSERT
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "user_update_admin_system"
ON "User"
FOR UPDATE
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "user_delete_system"
ON "User"
FOR DELETE
USING (app_private.is_system());

CREATE POLICY "session_select_admin_system"
ON "Session"
FOR SELECT
USING (app_private.is_admin_or_system());

CREATE POLICY "session_insert_system"
ON "Session"
FOR INSERT
WITH CHECK (app_private.is_system());

CREATE POLICY "session_update_admin_system"
ON "Session"
FOR UPDATE
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "session_delete_admin_system"
ON "Session"
FOR DELETE
USING (app_private.is_admin_or_system());

CREATE POLICY "csrf_token_system_all"
ON "CsrfToken"
FOR ALL
USING (app_private.is_system())
WITH CHECK (app_private.is_system());

CREATE POLICY "period_setting_select_all"
ON "PeriodSetting"
FOR SELECT
USING (true);

CREATE POLICY "period_setting_write_admin_system"
ON "PeriodSetting"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "notification_delivery_admin_system_all"
ON "NotificationDelivery"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "rate_limit_bucket_system_all"
ON "RateLimitBucket"
FOR ALL
USING (app_private.is_system())
WITH CHECK (app_private.is_system());

CREATE POLICY "reservation_select_owner_admin_system"
ON "Reservation"
FOR SELECT
USING (app_private.can_access_user("userId"));

CREATE POLICY "reservation_insert_owner_admin_system"
ON "Reservation"
FOR INSERT
WITH CHECK (app_private.can_access_user("userId"));

CREATE POLICY "reservation_update_owner_admin_system"
ON "Reservation"
FOR UPDATE
USING (app_private.can_access_user("userId"))
WITH CHECK (app_private.can_access_user("userId"));

CREATE POLICY "reservation_delete_admin_system"
ON "Reservation"
FOR DELETE
USING (app_private.is_admin_or_system());

CREATE POLICY "admin_action_select_self_admin_system"
ON "AdminAction"
FOR SELECT
USING (app_private.is_admin_or_system() OR app_private.current_user_id() = "actorId" OR app_private.current_user_id() = "targetUserId");

CREATE POLICY "admin_action_write_admin_system"
ON "AdminAction"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "audit_log_select_self_admin_system"
ON "AuditLog"
FOR SELECT
USING (app_private.is_admin_or_system() OR app_private.current_user_id() = "actorId" OR app_private.current_user_id() = "userId");

CREATE POLICY "audit_log_write_admin_system"
ON "AuditLog"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());

CREATE POLICY "user_sanction_select_self_admin_system"
ON "UserSanction"
FOR SELECT
USING (app_private.can_access_user("userId"));

CREATE POLICY "user_sanction_write_admin_system"
ON "UserSanction"
FOR ALL
USING (app_private.is_admin_or_system())
WITH CHECK (app_private.is_admin_or_system());
