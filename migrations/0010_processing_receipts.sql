ALTER TABLE public.inbound_events ADD CONSTRAINT inbound_events_source_unique
  UNIQUE (id, user_id, conversation_id);

CREATE FUNCTION public.valid_processing_result(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE draft jsonb;
BEGIN
  IF NOT coalesce(jsonb_typeof(value) = 'object'
    AND value - ARRAY['receiptType', 'receiptVersion', 'messages'] = '{}'::jsonb
    AND value->'receiptType' = '"foundation_echo"'::jsonb
    AND value->'receiptVersion' = '1'::jsonb
    AND jsonb_typeof(value->'messages') = 'array', false) THEN RETURN false; END IF;
  FOR draft IN SELECT jsonb_array_elements(value->'messages') LOOP
    IF NOT coalesce(jsonb_typeof(draft) = 'object'
      AND draft - ARRAY['version', 'kind', 'text'] = '{}'::jsonb
      AND draft->'version' = '1'::jsonb AND draft->'kind' = '"text"'::jsonb
      AND jsonb_typeof(draft->'text') = 'string', false) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.valid_processing_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_processing_result(jsonb) TO echo_worker;

CREATE TABLE public.processing_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  inbound_event_id uuid NOT NULL,
  receipt_type text NOT NULL CHECK (receipt_type = 'foundation_echo'),
  receipt_version integer NOT NULL CHECK (receipt_version = 1),
  result jsonb NOT NULL CHECK (public.valid_processing_result(result)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT processing_receipts_source_fk FOREIGN KEY (inbound_event_id, user_id, conversation_id)
    REFERENCES public.inbound_events(id, user_id, conversation_id),
  CONSTRAINT processing_receipts_event_type_unique UNIQUE (inbound_event_id, receipt_type)
);
CREATE INDEX processing_receipts_user_id_idx ON public.processing_receipts(user_id);
ALTER TABLE public.processing_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.processing_receipts FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
CREATE POLICY processing_receipts_migrator ON public.processing_receipts
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY processing_receipts_worker_select ON public.processing_receipts
  FOR SELECT TO echo_worker USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY processing_receipts_worker_insert ON public.processing_receipts
  FOR INSERT TO echo_worker WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT ON public.processing_receipts TO echo_worker;
UPDATE public.system_state SET schema_version = 10 WHERE id = 1 AND schema_version = 9;
