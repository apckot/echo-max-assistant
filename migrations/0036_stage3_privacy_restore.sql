CREATE INDEX pending_choice_expiry ON public.pending_choices(expires_at) WHERE state='pending';
CREATE FUNCTION public.expire_pending_choices(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;BEGIN
 IF batch IS NULL OR batch<1 OR batch>100 THEN RAISE EXCEPTION 'Invalid cleanup batch';END IF;
 PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup fenced';END IF;
 WITH due AS(SELECT user_id,id FROM public.pending_choices WHERE state='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT batch FOR UPDATE SKIP LOCKED)
 UPDATE public.pending_choices c SET state='expired' FROM due d WHERE c.user_id=d.user_id AND c.id=d.id;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END $$;
REVOKE ALL ON FUNCTION public.expire_pending_choices(integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.expire_pending_choices(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=36 WHERE id=1 AND schema_version=35;

CREATE OR REPLACE FUNCTION public.verified_choice_delivery(choice uuid,message_id text,conv uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.pending_choices c
 JOIN public.delivery_attempts d ON d.user_id=c.user_id AND d.outbound_message_id=c.outbound_id
 JOIN public.outbound_messages o ON o.user_id=c.user_id AND o.id=c.outbound_id
 JOIN public.inbound_events e ON e.user_id=c.user_id AND e.id=o.source_inbound_event_id
 JOIN public.conversations v ON v.user_id=c.user_id AND v.id=c.conversation_id
 WHERE c.id=choice AND c.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND c.conversation_id=conv
 AND v.state='active' AND e.sequence>v.delivery_cancelled_through_sequence
 AND d.phase='completed' AND d.certainty='sent' AND d.external_message_id=message_id)
$$;
