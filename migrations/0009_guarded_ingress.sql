-- Preserve one owner of identity, deduplication, sequence and lifecycle rules.
ALTER FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text)
  RENAME TO accept_max_inbound_internal;
REVOKE ALL ON FUNCTION public.accept_max_inbound_internal(text, text, text, timestamptz, jsonb, text)
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.accept_max_inbound_internal(text, text, text, timestamptz, jsonb, text)
  TO echo_migrator;

CREATE FUNCTION public.accept_max_inbound(
  external_user_id text, external_conversation_id text, event_key text,
  event_time timestamptz, event_payload jsonb, raw_hash text, hard_limit integer
) RETURNS TABLE (inbound_event_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $guarded$
DECLARE
  fenced boolean;
BEGIN
  IF hard_limit IS NULL OR hard_limit < 1 OR hard_limit > 1000000 THEN
    RAISE EXCEPTION 'Invalid ingress limit' USING ERRCODE = '22023';
  END IF;
  -- Hold the fence row through commit, including duplicate acknowledgements.
  SELECT s.restore_fence INTO fenced FROM public.system_state AS s WHERE s.id = 1 FOR SHARE;
  IF NOT FOUND OR fenced THEN
    RAISE EXCEPTION 'Ingress unavailable' USING ERRCODE = 'P0001';
  END IF;
  -- Serialize capacity check and insertion across all gateway processes.
  PERFORM pg_catalog.pg_advisory_xact_lock(1698727768, 1229866834);
  IF NOT EXISTS (SELECT 1 FROM public.inbound_events AS e
      WHERE e.provider = 'max' AND e.provider_event_key_sha256 = public.digest(event_key, 'sha256'))
    AND (SELECT count(*) FROM public.inbound_events AS e
      JOIN public.conversations AS c ON c.id = e.conversation_id AND c.user_id = e.user_id
      WHERE e.sequence >= c.next_apply_sequence) >= hard_limit THEN
    RAISE EXCEPTION 'Ingress unavailable' USING ERRCODE = 'P0001';
  END IF;
  -- The original algorithm validates full keys and ownership even on retries.
  RETURN QUERY SELECT * FROM public.accept_max_inbound_internal(
    external_user_id, external_conversation_id, event_key, event_time, event_payload, raw_hash);
END;
$guarded$;
REVOKE ALL ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text, integer)
  FROM PUBLIC, echo_migrator, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text, integer)
  -- The trusted definer owner needs execution for the six-argument wrapper below.
  TO echo_gateway, echo_migrator;

-- Keep the established six-argument gateway API guarded with the default limit.
CREATE FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text)
RETURNS TABLE (inbound_event_id uuid, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $default_limit$
  SELECT * FROM public.accept_max_inbound($1, $2, $3, $4, $5, $6, 100000);
$default_limit$;
REVOKE ALL ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text)
  FROM PUBLIC, echo_migrator, echo_worker, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.accept_max_inbound(text, text, text, timestamptz, jsonb, text)
  TO echo_gateway;

UPDATE public.system_state SET schema_version = 9 WHERE id = 1 AND schema_version = 8;
