CREATE FUNCTION public.valid_outbound_payload(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(value) = 'object'
    AND value - ARRAY['version', 'kind', 'text'] = '{}'::jsonb
    AND value->'version' = '1'::jsonb
    AND value->'kind' = '"text"'::jsonb
    AND jsonb_typeof(value->'text') = 'string', false)
$$;
REVOKE ALL ON FUNCTION public.valid_outbound_payload(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_outbound_payload(jsonb) TO echo_worker, echo_delivery;

CREATE TABLE public.outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_inbound_event_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'max' CHECK (provider = 'max'),
  message_index integer NOT NULL CHECK (message_index >= 0),
  payload jsonb NOT NULL CHECK (public.valid_outbound_payload(payload)),
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK
    (status IN ('pending', 'sending', 'sent', 'retry', 'not_sent', 'uncertain', 'dead', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbound_messages_source_fk FOREIGN KEY (source_inbound_event_id, user_id, conversation_id)
    REFERENCES public.inbound_events(id, user_id, conversation_id),
  CONSTRAINT outbound_messages_source_index_unique UNIQUE (source_inbound_event_id, message_index),
  CONSTRAINT outbound_messages_provider_dedupe_unique UNIQUE (provider, dedupe_key),
  CONSTRAINT outbound_messages_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT outbound_messages_dedupe_shape CHECK
    (dedupe_key = 'response:' || source_inbound_event_id::text || ':' || message_index::text || ':v1')
);
CREATE INDEX outbound_messages_user_status_idx ON public.outbound_messages(user_id, status);
ALTER TABLE public.outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_messages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_messages FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
CREATE POLICY outbound_messages_migrator ON public.outbound_messages
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY outbound_messages_worker_select ON public.outbound_messages
  FOR SELECT TO echo_worker USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY outbound_messages_worker_insert ON public.outbound_messages
  FOR INSERT TO echo_worker WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY outbound_messages_delivery_select ON public.outbound_messages
  FOR SELECT TO echo_delivery USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY outbound_messages_delivery_update ON public.outbound_messages
  FOR UPDATE TO echo_delivery USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT ON public.outbound_messages TO echo_worker;
GRANT INSERT (user_id, conversation_id, source_inbound_event_id, provider, message_index, payload, dedupe_key)
  ON public.outbound_messages TO echo_worker;
GRANT SELECT, UPDATE (status, updated_at) ON public.outbound_messages TO echo_delivery;

CREATE TABLE public.delivery_work (
  outbound_message_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  lease_owner uuid,
  lease_until timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'leased', 'retry', 'dead', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT delivery_work_outbound_fk FOREIGN KEY (outbound_message_id, user_id)
    REFERENCES public.outbound_messages(id, user_id) ON DELETE CASCADE,
  CONSTRAINT delivery_work_lease_shape CHECK
    ((state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL))
);
CREATE INDEX delivery_work_available_idx ON public.delivery_work(available_at)
  WHERE state IN ('ready', 'retry');
REVOKE ALL ON public.delivery_work FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
GRANT INSERT (outbound_message_id, user_id) ON public.delivery_work TO echo_worker;
GRANT SELECT ON public.delivery_work TO echo_worker;
GRANT SELECT, UPDATE (available_at, attempt_count, last_error_code, lease_owner, lease_until,
  lease_generation, state, updated_at) ON public.delivery_work TO echo_delivery;

-- Existing receipts were committed before this table existed. Materialize their ordered drafts
-- without invoking handlers or touching the inbound event and sequence counters.
INSERT INTO public.outbound_messages
  (user_id, conversation_id, source_inbound_event_id, provider, message_index, payload, dedupe_key)
SELECT r.user_id, r.conversation_id, r.inbound_event_id, 'max', (draft.ordinality - 1)::integer,
  draft.value, 'response:' || r.inbound_event_id::text || ':' || (draft.ordinality - 1)::text || ':v1'
FROM public.processing_receipts AS r
CROSS JOIN LATERAL jsonb_array_elements(r.result->'messages') WITH ORDINALITY AS draft(value, ordinality);
INSERT INTO public.delivery_work (outbound_message_id, user_id)
SELECT id, user_id FROM public.outbound_messages;

UPDATE public.system_state SET schema_version = 13 WHERE id = 1 AND schema_version = 12;
