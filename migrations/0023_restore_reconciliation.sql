CREATE TABLE public.restore_incidents (
 id uuid PRIMARY KEY,snapshot_at timestamptz NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),reopened_at timestamptz
);
REVOKE ALL ON public.restore_incidents FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler;
ALTER TABLE public.outbound_messages DROP CONSTRAINT outbound_messages_status_check;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_status_check CHECK
 (status IN ('pending','sending','sent','retry','not_sent','uncertain','uncertain_restore','dead','cancelled'));

-- An old inbound can be processed only after reopen. Its newly materialized reply is still old work.
CREATE FUNCTION public.quarantine_restored_outbound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot timestamptz;
BEGIN
 SELECT restored_snapshot_at INTO snapshot FROM public.system_state WHERE id=1 FOR SHARE;
 IF snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM public.inbound_events WHERE id=NEW.source_inbound_event_id AND created_at<=snapshot) THEN
  NEW.status:='uncertain_restore';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.quarantine_restored_outbound() FROM PUBLIC;
CREATE TRIGGER quarantine_restored_outbound BEFORE INSERT ON public.outbound_messages
 FOR EACH ROW EXECUTE FUNCTION public.quarantine_restored_outbound();
CREATE FUNCTION public.quarantine_restored_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.outbound_messages WHERE id=NEW.outbound_message_id AND status='uncertain_restore') THEN
  NEW.state:='cancelled';NEW.lease_owner:=NULL;NEW.lease_until:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.quarantine_restored_delivery() FROM PUBLIC;
CREATE TRIGGER quarantine_restored_delivery BEFORE INSERT ON public.delivery_work
 FOR EACH ROW EXECUTE FUNCTION public.quarantine_restored_delivery();

-- Invoker functions: only the offline migrator/operator owns metadata and tenant-wide visibility.
CREATE FUNCTION public.reconcile_restore(incident uuid,snapshot timestamptz,apply boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE fenced boolean;previous public.restore_incidents;affected integer;
BEGIN
 IF incident IS NULL OR snapshot IS NULL OR snapshot>clock_timestamp() THEN RAISE EXCEPTION 'Invalid restore input'; END IF;
 SELECT restore_fence INTO fenced FROM public.system_state WHERE id=1 FOR UPDATE;
 IF fenced IS DISTINCT FROM true THEN RAISE EXCEPTION 'Restore requires fence';END IF;
 SELECT * INTO previous FROM public.restore_incidents WHERE id=incident;
 IF FOUND THEN
  IF previous.snapshot_at<>snapshot THEN RAISE EXCEPTION 'Incident snapshot mismatch';END IF;
  RETURN jsonb_build_object('applied',true,'outbound',0,'already_applied',true);
 END IF;
 SELECT count(*) INTO affected FROM public.outbound_messages WHERE status IN ('pending','sending','retry') AND created_at<=snapshot;
 IF NOT apply THEN RETURN jsonb_build_object('applied',false,'outbound',affected);END IF;
 INSERT INTO public.restore_incidents(id,snapshot_at) VALUES(incident,snapshot);
 UPDATE public.system_state SET restored_snapshot_at=snapshot,deployment_epoch=deployment_epoch+1 WHERE id=1;
 UPDATE public.outbound_messages SET status='uncertain_restore',updated_at=clock_timestamp()
  WHERE status IN ('pending','sending','retry') AND created_at<=snapshot;
 UPDATE public.delivery_work w SET state='cancelled',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1,updated_at=clock_timestamp()
  FROM public.outbound_messages o WHERE o.id=w.outbound_message_id AND o.status='uncertain_restore';
 UPDATE public.conversation_work SET state='ready',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1
  WHERE state='leased';
 RETURN jsonb_build_object('applied',true,'outbound',affected);
END $$;
CREATE FUNCTION public.reopen_restore(incident uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM public.system_state WHERE id=1 AND restore_fence FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Restore not fenced';END IF;
 UPDATE public.restore_incidents SET reopened_at=clock_timestamp() WHERE id=incident AND reopened_at IS NULL
  AND snapshot_at=(SELECT restored_snapshot_at FROM public.system_state WHERE id=1);
 IF NOT FOUND THEN RAISE EXCEPTION 'Applied incident required';END IF;
 UPDATE public.system_state SET restore_fence=false WHERE id=1;
END $$;
REVOKE ALL ON FUNCTION public.reconcile_restore(uuid,timestamptz,boolean),public.reopen_restore(uuid)
 FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler;
CREATE OR REPLACE FUNCTION public.retain_technical_records(as_of timestamptz,batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE conversations integer; deliveries integer; attempts integer;
BEGIN
  IF as_of IS NULL OR as_of>clock_timestamp() OR batch_limit IS NULL OR batch_limit<1 OR batch_limit>100 THEN
    RAISE EXCEPTION 'Invalid retention input' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retention fenced'; END IF;
  -- Parent locks precede work locks, matching ingress/processing. They also
  -- serialize retirement with BEFORE INSERT generation restoration.
  WITH parents AS MATERIALIZED (
    SELECT c.id FROM public.conversations c WHERE EXISTS(SELECT 1 FROM public.conversation_work w
      WHERE w.conversation_id=c.id AND w.state='dead' AND w.incident_closed_at<as_of-interval '30 days')
    ORDER BY c.id LIMIT 100 FOR UPDATE SKIP LOCKED
  ), candidates AS MATERIALIZED (
    SELECT w.conversation_id,w.user_id,w.lease_generation FROM public.conversation_work w JOIN parents p ON p.id=w.conversation_id
    WHERE w.state='dead' AND w.incident_closed_at<as_of-interval '30 days' ORDER BY w.lease_generation LIMIT batch_limit FOR UPDATE OF w SKIP LOCKED
  ), remembered AS (
    INSERT INTO public.conversation_work_generations(conversation_id,user_id,generation)
    SELECT conversation_id,user_id,lease_generation FROM candidates
    ON CONFLICT(conversation_id) DO UPDATE SET generation=GREATEST(conversation_work_generations.generation,EXCLUDED.generation)
    RETURNING conversation_id
  ) DELETE FROM public.conversation_work w USING remembered r WHERE w.conversation_id=r.conversation_id;
  GET DIAGNOSTICS conversations=ROW_COUNT;
  -- Lock terminal outbound rows before their journal; active/sending attempts must remain
  -- available for admission and certainty recovery. Delete all phases as one FK-safe group.
  PERFORM set_config('app.privacy_erasure','on',true);
  WITH candidates AS MATERIALIZED (
    SELECT o.id FROM public.outbound_messages o WHERE o.status IN ('sent','uncertain','dead','cancelled','not_sent','uncertain_restore')
      AND EXISTS (SELECT 1 FROM public.delivery_attempts a WHERE a.outbound_message_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM public.delivery_attempts a WHERE a.outbound_message_id=o.id AND a.recorded_at>=as_of-interval '90 days')
      AND NOT EXISTS (SELECT 1 FROM public.delivery_work w WHERE w.outbound_message_id=o.id AND w.state IN ('ready','leased','retry'))
    ORDER BY o.id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.delivery_attempts a USING candidates c WHERE a.outbound_message_id=c.id;
  GET DIAGNOSTICS attempts=ROW_COUNT;
  PERFORM set_config('app.privacy_erasure','off',true);
  WITH parents AS MATERIALIZED (
    SELECT o.id FROM public.outbound_messages o WHERE EXISTS(SELECT 1 FROM public.delivery_work w
      WHERE w.outbound_message_id=o.id AND w.state='dead' AND w.incident_closed_at<as_of-interval '30 days')
    ORDER BY o.id LIMIT 100 FOR UPDATE SKIP LOCKED
  ), candidates AS MATERIALIZED (
    SELECT w.outbound_message_id,w.user_id,w.lease_generation FROM public.delivery_work w JOIN parents p ON p.id=w.outbound_message_id
    WHERE w.state='dead' AND w.incident_closed_at<as_of-interval '30 days' ORDER BY w.lease_generation LIMIT batch_limit FOR UPDATE OF w SKIP LOCKED
  ), remembered AS (
    INSERT INTO public.delivery_work_generations(outbound_message_id,user_id,generation)
    SELECT outbound_message_id,user_id,lease_generation FROM candidates
    ON CONFLICT(outbound_message_id) DO UPDATE SET generation=GREATEST(delivery_work_generations.generation,EXCLUDED.generation)
    RETURNING outbound_message_id
  ) DELETE FROM public.delivery_work w USING remembered r WHERE w.outbound_message_id=r.outbound_message_id;
  GET DIAGNOSTICS deliveries=ROW_COUNT;
  RETURN jsonb_build_object('conversationWork',conversations,'deliveryWork',deliveries,'attempts',attempts);
END $$;


UPDATE public.system_state SET schema_version=23 WHERE id=1 AND schema_version=22;
