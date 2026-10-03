-- Share the established identity algorithm without widening its public contract.
ALTER FUNCTION public.resolve_or_create_max_identity(text, text, text)
  RENAME TO resolve_max_identity_internal;
REVOKE ALL ON FUNCTION public.resolve_max_identity_internal(text, text, text)
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.resolve_max_identity_internal(text, text, text) TO echo_migrator;

CREATE FUNCTION public.resolve_or_create_max_identity(text, text, text)
RETURNS TABLE (user_id uuid, channel_account_id uuid, conversation_id uuid, state text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $wrapper$
  SELECT * FROM public.resolve_max_identity_internal($1, $2, $3);
$wrapper$;
REVOKE ALL ON FUNCTION public.resolve_or_create_max_identity(text, text, text)
  FROM PUBLIC, echo_migrator, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_max_identity(text, text, text) TO echo_gateway;

CREATE FUNCTION public.accept_max_inbound(
  external_user_id text, external_conversation_id text, event_key text,
  event_time timestamptz, event_payload jsonb, raw_hash text
) RETURNS TABLE (inbound_event_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $intake$
DECLARE
  identity_row record;
  existing_event public.inbound_events%ROWTYPE;
  event_digest bytea;
  event_id uuid;
  next_sequence bigint;
  timezone_value text;
BEGIN
  IF event_key IS NULL OR length(event_key) = 0 OR event_time IS NULL OR NOT isfinite(event_time) THEN
    RAISE EXCEPTION 'Invalid inbound event' USING ERRCODE = '22023';
  END IF;
  event_digest := public.digest(event_key, 'sha256');
  -- One event lock precedes the resolver's user/chat locks in every intake.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('max:event:' || encode(event_digest, 'hex'), 0));
  -- Authenticate ownership without applying lifecycle effects on a retry.
  SELECT * INTO identity_row FROM public.resolve_max_identity_internal(
    external_user_id, external_conversation_id, 'message_created');
  SELECT u.timezone INTO timezone_value FROM public.users AS u
    WHERE u.id = identity_row.user_id AND u.status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MAX identity unavailable' USING ERRCODE = 'P0001';
  END IF;
  SELECT e.* INTO existing_event FROM public.inbound_events AS e
    WHERE e.provider = 'max' AND e.provider_event_key_sha256 = event_digest;
  IF FOUND THEN
    -- Digest matches are insufficient: even an actual SHA collision fails closed.
    IF existing_event.provider_event_key IS DISTINCT FROM event_key
      OR existing_event.user_id IS DISTINCT FROM identity_row.user_id
      OR existing_event.conversation_id IS DISTINCT FROM identity_row.conversation_id THEN
      RAISE EXCEPTION 'Inbound event unavailable' USING ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT existing_event.id, 'duplicate'::text;
    RETURN;
  END IF;

  IF event_payload->>'kind' = 'lifecycle' THEN
    PERFORM public.resolve_max_identity_internal(external_user_id, external_conversation_id,
      CASE event_payload->>'lifecycleType' WHEN 'started' THEN 'bot_started'
        WHEN 'stopped' THEN 'bot_stopped' ELSE NULL END);
  END IF;
  SELECT c.next_inbound_sequence INTO next_sequence FROM public.conversations AS c
    WHERE c.id = identity_row.conversation_id FOR UPDATE;
  INSERT INTO public.inbound_events (user_id, conversation_id, provider, provider_event_key,
    sequence, kind, occurred_at, timezone_snapshot, payload, raw_sha256)
  VALUES (identity_row.user_id, identity_row.conversation_id, 'max', event_key,
    next_sequence, event_payload->>'kind', event_time, timezone_value, event_payload, raw_hash)
  RETURNING id INTO event_id;
  UPDATE public.conversations AS c SET next_inbound_sequence = next_sequence + 1, updated_at = now()
    WHERE c.id = identity_row.conversation_id;
  -- Queue wake/upsert is deliberately reserved for the next migration, in this transaction.
  RETURN QUERY SELECT event_id, 'created'::text;
END;
$intake$;
REVOKE ALL ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text)
  FROM PUBLIC, echo_migrator, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text) TO echo_gateway;

UPDATE public.system_state SET schema_version = 7 WHERE id = 1 AND schema_version = 6;
