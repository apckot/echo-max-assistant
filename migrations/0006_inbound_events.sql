ALTER TABLE public.conversations ADD CONSTRAINT conversations_id_user_id_unique UNIQUE (id, user_id);

CREATE TABLE public.inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  conversation_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'max'),
  provider_event_key text NOT NULL CHECK (length(provider_event_key) > 0),
  provider_event_key_sha256 bytea GENERATED ALWAYS AS (digest(provider_event_key, 'sha256')) STORED,
  sequence bigint NOT NULL CHECK (sequence > 0),
  kind text NOT NULL CHECK (kind IN ('text', 'voice', 'button', 'lifecycle')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  timezone_snapshot text NOT NULL CHECK (length(trim(timezone_snapshot)) > 0),
  payload jsonb NOT NULL CHECK (coalesce((
    jsonb_typeof(payload) = 'object' AND
    octet_length(payload::text) <= 131072 AND
    payload->>'kind' = kind AND (
      (kind = 'text' AND payload - ARRAY['kind', 'text', 'replyToMessageId'] = '{}'::jsonb
        AND jsonb_typeof(payload->'text') = 'string'
        AND length(payload->>'text') BETWEEN 1 AND 16000
        AND octet_length(payload->>'text') <= 65536)
      OR (kind = 'voice' AND payload - ARRAY['kind', 'media', 'replyToMessageId'] = '{}'::jsonb
        AND jsonb_typeof(payload->'media') = 'object'
        AND (payload->'media') - ARRAY['url', 'token'] = '{}'::jsonb
        AND jsonb_typeof(payload->'media'->'url') = 'string'
        AND length(payload->'media'->>'url') > 0
        AND jsonb_typeof(payload->'media'->'token') = 'string'
        AND length(payload->'media'->>'token') > 0)
      OR (kind = 'button' AND payload - ARRAY['kind', 'callbackPayload', 'replyToMessageId'] = '{}'::jsonb
        AND jsonb_typeof(payload->'callbackPayload') = 'string')
      OR (kind = 'lifecycle' AND payload - ARRAY['kind', 'lifecycleType'] = '{}'::jsonb
        AND payload->>'lifecycleType' IN ('started', 'stopped'))
    ) AND (NOT payload ? 'replyToMessageId' OR
      (jsonb_typeof(payload->'replyToMessageId') = 'string' AND length(payload->>'replyToMessageId') > 0))
  ), false)),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  preparation_status text NOT NULL DEFAULT 'ready' CHECK (preparation_status IN ('ready', 'preparing', 'failed')),
  processing_status text NOT NULL DEFAULT 'accepted' CHECK (processing_status IN ('accepted', 'processing', 'applied', 'failed', 'ignored')),
  failure_code text CHECK (failure_code IN ('invalid_payload', 'capability_unavailable', 'processing_error', 'retry_exhausted')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  preparation_started_at timestamptz,
  processing_started_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_events_conversation_tenant_fk FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversations(id, user_id),
  -- Keep the full canonical key above. A fixed-size digest avoids PostgreSQL's
  -- btree entry-size limit; intake must compare full keys on a digest conflict.
  CONSTRAINT inbound_events_provider_key_unique UNIQUE (provider, provider_event_key_sha256),
  CONSTRAINT inbound_events_conversation_sequence_unique UNIQUE (conversation_id, sequence)
);

CREATE INDEX inbound_events_user_id_idx ON public.inbound_events(user_id);
ALTER TABLE public.inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_events FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;

CREATE POLICY inbound_events_migrator ON public.inbound_events
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY inbound_events_worker_select ON public.inbound_events
  FOR SELECT TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY inbound_events_worker_update ON public.inbound_events
  FOR UPDATE TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT ON public.inbound_events TO echo_worker;
GRANT UPDATE (preparation_status, processing_status, failure_code, attempt_count,
  preparation_started_at, processing_started_at, processed_at, updated_at)
  ON public.inbound_events TO echo_worker;

UPDATE public.system_state SET schema_version = 6 WHERE id = 1 AND schema_version = 5;
