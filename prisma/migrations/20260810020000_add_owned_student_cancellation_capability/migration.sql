CREATE OR REPLACE FUNCTION app_private.cancel_owned_student_reservation(
  reservation_id text,
  request_ip_hash text,
  admin_action_id text,
  sanction_id text,
  audit_log_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  actor_id text := nullif(pg_catalog.current_setting('app.current_user_id', true), '');
  actor_role text := nullif(pg_catalog.current_setting('app.current_user_role', true), '');
  reservation_row "public"."Reservation"%ROWTYPE;
  user_booking_status text;
  restriction_reason constant text := '예약 취소';
  restricted_until timestamp(3) := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp()) + interval '3 days';
BEGIN
  IF actor_id IS NULL OR actor_role IS DISTINCT FROM 'STUDENT' THEN
    RAISE EXCEPTION 'student cancellation requires a transaction-local STUDENT actor'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO reservation_row
  FROM "public"."Reservation"
  WHERE "id" = reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'NOT_FOUND';
  END IF;
  IF reservation_row."userId" IS DISTINCT FROM actor_id THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF reservation_row."status" = 'CANCELLED' THEN
    RETURN 'CANCELLED';
  END IF;
  IF reservation_row."status" IS DISTINCT FROM 'CONFIRMED' THEN
    RETURN 'NOT_CANCELLABLE';
  END IF;

  SELECT "bookingStatus"
  INTO STRICT user_booking_status
  FROM "public"."User"
  WHERE "id" = actor_id
  FOR UPDATE;

  UPDATE "public"."Reservation"
  SET "status" = 'CANCELLED', "updatedAt" = pg_catalog.clock_timestamp()
  WHERE "id" = reservation_id AND "status" = 'CONFIRMED';

  IF NOT FOUND THEN
    RETURN 'NOT_CANCELLABLE';
  END IF;

  IF user_booking_status IS DISTINCT FROM 'SHADOW_BANNED' THEN
    UPDATE "public"."User"
    SET
      "bookingStatus" = 'RESTRICTED',
      "restrictedUntil" = restricted_until,
      "restrictionReason" = restriction_reason,
      "updatedAt" = pg_catalog.clock_timestamp()
    WHERE "id" = actor_id;

    INSERT INTO "public"."AdminAction" (
      "id", "actorId", "targetUserId", "reservationId", "action", "reason", "before", "after", "ipHash"
    ) VALUES (
      admin_action_id,
      actor_id,
      actor_id,
      reservation_id,
      'STUDENT_RESERVATION_CANCEL_RESTRICTION',
      restriction_reason,
      pg_catalog.jsonb_build_object('reservationStatus', reservation_row."status")::text,
      pg_catalog.jsonb_build_object(
        'bookingStatus', 'RESTRICTED',
        'reservationStatus', 'CANCELLED',
        'restrictionReason', restriction_reason,
        'restrictedUntil', restricted_until
      )::text,
      request_ip_hash
    );

    UPDATE "public"."UserSanction"
    SET
      "revokedAt" = pg_catalog.clock_timestamp(),
      "revokedById" = actor_id,
      "revokedReason" = '새 예약 취소 제한으로 대체',
      "status" = 'REVOKED'
    WHERE
      "userId" = actor_id
      AND "status" = 'ACTIVE'
      AND "type" = 'CANCELLATION_RESTRICTION';

    INSERT INTO "public"."UserSanction" (
      "id", "userId", "actorId", "sourceActionId", "type", "status", "reason", "endsAt"
    ) VALUES (
      sanction_id,
      actor_id,
      actor_id,
      admin_action_id,
      'CANCELLATION_RESTRICTION',
      'ACTIVE',
      restriction_reason,
      restricted_until
    );

    INSERT INTO "public"."AuditLog" ("id", "actorId", "userId", "action", "detail")
    VALUES (
      audit_log_id,
      actor_id,
      actor_id,
      'STUDENT_RESERVATION_CANCEL_RESTRICTION',
      pg_catalog.jsonb_build_object(
        'actionId', admin_action_id,
        'reservationId', reservation_id,
        'restrictedUntil', restricted_until
      )::text
    );
  END IF;

  RETURN 'CANCELLED';
END;
$$;

REVOKE ALL ON FUNCTION app_private.cancel_owned_student_reservation(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.cancel_owned_student_reservation(text, text, text, text, text) TO info_room_runtime;
