ALTER TABLE public.conversation_work ADD COLUMN incident_closed_at timestamptz;
ALTER TABLE public.delivery_work ADD COLUMN incident_closed_at timestamptz;
CREATE FUNCTION public.reset_work_incident() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state<>'dead' OR OLD.state<>'dead' THEN NEW.incident_closed_at:=NULL; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reset_work_incident() FROM PUBLIC;
CREATE TRIGGER conversation_incident_reset BEFORE UPDATE OF state ON public.conversation_work
  FOR EACH ROW EXECUTE FUNCTION public.reset_work_incident();
CREATE TRIGGER delivery_incident_reset BEFORE UPDATE OF state ON public.delivery_work
  FOR EACH ROW EXECUTE FUNCTION public.reset_work_incident();

CREATE FUNCTION public.close_technical_incident(work_kind text,work_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF work_kind='conversation' THEN
    UPDATE public.conversation_work SET incident_closed_at=clock_timestamp() WHERE conversation_id=work_id AND state='dead' AND incident_closed_at IS NULL;
  ELSIF work_kind='delivery' THEN
    UPDATE public.delivery_work SET incident_closed_at=clock_timestamp() WHERE outbound_message_id=work_id AND state='dead' AND incident_closed_at IS NULL;
  ELSE RAISE EXCEPTION 'Invalid work kind' USING ERRCODE='22023'; END IF;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.close_technical_incident(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_technical_incident(text,uuid) TO echo_scheduler;

-- Only a narrow definer operation can delete immutable facts. Runtime GUC spoofing
-- cannot bypass the current_user check; ordinary migrator operations still reject mutation.
CREATE OR REPLACE FUNCTION public.reject_delivery_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND current_user='echo_migrator' AND current_setting('app.privacy_erasure',true)='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Delivery attempt facts are immutable';
END $$;
CREATE FUNCTION public.retain_technical_records(as_of timestamptz,batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE conversations integer; deliveries integer; attempts integer;
BEGIN
  IF as_of IS NULL OR as_of>clock_timestamp() OR batch_limit IS NULL OR batch_limit<1 OR batch_limit>100 THEN
    RAISE EXCEPTION 'Invalid retention input' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retention fenced'; END IF;
  -- Lock terminal outbound rows before their journal; active/sending attempts must remain
  -- available for admission and certainty recovery. Delete all phases as one FK-safe group.
  PERFORM set_config('app.privacy_erasure','on',true);
  WITH candidates AS MATERIALIZED (
    SELECT o.id FROM public.outbound_messages o WHERE o.status IN ('sent','uncertain','dead','cancelled')
      AND EXISTS (SELECT 1 FROM public.delivery_attempts a WHERE a.outbound_message_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM public.delivery_attempts a WHERE a.outbound_message_id=o.id AND a.recorded_at>=as_of-interval '90 days')
      AND NOT EXISTS (SELECT 1 FROM public.delivery_work w WHERE w.outbound_message_id=o.id AND w.state IN ('ready','leased','retry'))
    ORDER BY o.id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.delivery_attempts a USING candidates c WHERE a.outbound_message_id=c.id;
  GET DIAGNOSTICS attempts=ROW_COUNT;
  PERFORM set_config('app.privacy_erasure','off',true);
  WITH candidates AS MATERIALIZED (
    SELECT conversation_id FROM public.conversation_work WHERE state='dead' AND incident_closed_at<as_of-interval '30 days'
    ORDER BY incident_closed_at,conversation_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.conversation_work w USING candidates c WHERE w.conversation_id=c.conversation_id;
  GET DIAGNOSTICS conversations=ROW_COUNT;
  WITH candidates AS MATERIALIZED (
    SELECT outbound_message_id FROM public.delivery_work WHERE state='dead' AND incident_closed_at<as_of-interval '30 days'
    ORDER BY incident_closed_at,outbound_message_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.delivery_work w USING candidates c WHERE w.outbound_message_id=c.outbound_message_id;
  GET DIAGNOSTICS deliveries=ROW_COUNT;
  RETURN jsonb_build_object('conversationWork',conversations,'deliveryWork',deliveries,'attempts',attempts);
END $$;
REVOKE ALL ON FUNCTION public.retain_technical_records(timestamptz,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retain_technical_records(timestamptz,integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=20 WHERE id=1 AND schema_version=19;
