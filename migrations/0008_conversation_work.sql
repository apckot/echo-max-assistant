CREATE TABLE public.conversation_work (
  conversation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  lease_owner uuid,
  lease_until timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'leased', 'retry', 'dead')),
  CONSTRAINT conversation_work_conversation_tenant_fk FOREIGN KEY (conversation_id, user_id)
    REFERENCES public.conversations(id, user_id) ON DELETE CASCADE,
  CONSTRAINT conversation_work_lease_shape CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX conversation_work_available_idx ON public.conversation_work (available_at)
  WHERE state IN ('ready', 'retry');

REVOKE ALL ON public.conversation_work FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
GRANT SELECT ON public.conversation_work TO echo_worker, echo_scheduler;
GRANT UPDATE (available_at, attempt_count, last_error_code, lease_owner, lease_until,
  lease_generation, state) ON public.conversation_work TO echo_worker;

CREATE FUNCTION public.wake_conversation_work_on_inbound()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $wake$
BEGIN
  INSERT INTO public.conversation_work (conversation_id, user_id)
    VALUES (NEW.conversation_id, NEW.user_id)
  ON CONFLICT (conversation_id) DO UPDATE SET
    available_at = CASE WHEN public.conversation_work.state = 'leased'
      THEN public.conversation_work.available_at ELSE now() END,
    attempt_count = CASE WHEN public.conversation_work.state = 'leased'
      THEN public.conversation_work.attempt_count ELSE 0 END,
    last_error_code = CASE WHEN public.conversation_work.state = 'leased'
      THEN public.conversation_work.last_error_code ELSE NULL END,
    state = CASE WHEN public.conversation_work.state = 'leased'
      THEN 'leased' ELSE 'ready' END;
  PERFORM pg_catalog.pg_notify('conversation_work_wake', NEW.conversation_id::text);
  RETURN NEW;
END;
$wake$;
REVOKE ALL ON FUNCTION public.wake_conversation_work_on_inbound()
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
CREATE TRIGGER inbound_events_wake_conversation
  AFTER INSERT ON public.inbound_events FOR EACH ROW
  EXECUTE FUNCTION public.wake_conversation_work_on_inbound();

UPDATE public.system_state SET schema_version = 8 WHERE id = 1 AND schema_version = 7;
