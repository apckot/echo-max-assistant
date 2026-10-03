CREATE OR REPLACE FUNCTION public.wake_conversation_work_on_inbound()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $wake$
BEGIN
  INSERT INTO public.conversation_work (conversation_id, user_id)
    VALUES (NEW.conversation_id, NEW.user_id)
  ON CONFLICT (conversation_id) DO UPDATE SET
    available_at = CASE WHEN public.conversation_work.state IN ('leased', 'retry')
      THEN public.conversation_work.available_at ELSE now() END,
    attempt_count = CASE WHEN public.conversation_work.state IN ('leased', 'retry')
      THEN public.conversation_work.attempt_count ELSE 0 END,
    last_error_code = CASE WHEN public.conversation_work.state IN ('leased', 'retry')
      THEN public.conversation_work.last_error_code ELSE NULL END,
    state = CASE WHEN public.conversation_work.state IN ('leased', 'retry')
      THEN public.conversation_work.state ELSE 'ready' END;
  PERFORM pg_catalog.pg_notify('conversation_work_wake', NEW.conversation_id::text);
  RETURN NEW;
END;
$wake$;
REVOKE ALL ON FUNCTION public.wake_conversation_work_on_inbound()
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;

UPDATE public.system_state SET schema_version = 11 WHERE id = 1 AND schema_version = 10;
