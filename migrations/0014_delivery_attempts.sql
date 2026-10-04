-- Each immutable fact identifies the lease that admitted the original attempt.
-- Recovery appends a completion with that original token, under a separately
-- fenced recovery transaction; it does not invent a second dispatch start.
CREATE TABLE public.delivery_attempts (
  outbound_message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 6),
  phase text NOT NULL CHECK (phase IN ('started', 'completed')),
  lease_owner uuid NOT NULL,
  lease_generation bigint NOT NULL CHECK (lease_generation > 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  certainty text,
  code text,
  external_message_id text,
  start_phase text GENERATED ALWAYS AS ('started'::text) STORED,
  PRIMARY KEY (outbound_message_id, attempt_number, phase),
  UNIQUE (outbound_message_id, user_id, attempt_number, lease_owner, lease_generation, phase),
  FOREIGN KEY (outbound_message_id, user_id) REFERENCES public.outbound_messages(id, user_id),
  FOREIGN KEY (outbound_message_id, user_id, attempt_number, lease_owner, lease_generation, start_phase)
    REFERENCES public.delivery_attempts
      (outbound_message_id, user_id, attempt_number, lease_owner, lease_generation, phase),
  CONSTRAINT delivery_attempts_fact_shape CHECK (coalesce(
    (phase = 'started' AND certainty IS NULL AND code IS NULL AND external_message_id IS NULL)
    OR (phase = 'completed' AND (
      (certainty = 'sent' AND code IS NULL AND length(external_message_id) > 0)
      OR (certainty = 'not_sent' AND external_message_id IS NULL AND code IN
        ('invalid_input', 'rate_limited', 'rejected', 'preconnection_failure', 'rate_limit_unschedulable'))
      OR (certainty = 'uncertain' AND external_message_id IS NULL AND code IN
        ('timeout', 'transport_failure', 'invalid_response', 'response_too_large', 'server_failure',
         'unexpected_status', 'attempt_abandoned', 'sender_exception'))
    )), false))
);
ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_attempts FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
CREATE POLICY delivery_attempts_migrator ON public.delivery_attempts
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY delivery_attempts_delivery_select ON public.delivery_attempts
  FOR SELECT TO echo_delivery USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY delivery_attempts_delivery_insert ON public.delivery_attempts
  FOR INSERT TO echo_delivery WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT ON public.delivery_attempts TO echo_delivery;
GRANT INSERT (outbound_message_id, user_id, attempt_number, phase, lease_owner, lease_generation,
  certainty, code, external_message_id) ON public.delivery_attempts TO echo_delivery;

CREATE FUNCTION public.reject_delivery_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Delivery attempt facts are immutable';
END
$$;
REVOKE ALL ON FUNCTION public.reject_delivery_attempt_mutation() FROM PUBLIC;
CREATE TRIGGER delivery_attempts_immutable BEFORE UPDATE OR DELETE ON public.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION public.reject_delivery_attempt_mutation();

-- Keep terminal work rows so a late claim cannot reset their generation.
ALTER TABLE public.delivery_work DROP CONSTRAINT delivery_work_state_check;
ALTER TABLE public.delivery_work ADD CONSTRAINT delivery_work_state_check
  CHECK (state IN ('ready', 'leased', 'retry', 'sent', 'uncertain', 'dead', 'cancelled'));

UPDATE public.system_state SET schema_version = 14 WHERE id = 1 AND schema_version = 13;
