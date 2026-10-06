-- Retired generation is identity-scoped authority, not deletable queue work.
-- These system metadata tables contain internal IDs only. Privacy erasure
-- removes them via parent FKs without retaining a target mapping.
CREATE TABLE public.conversation_work_generations (
  conversation_id uuid PRIMARY KEY,user_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>=0),
  FOREIGN KEY(conversation_id,user_id) REFERENCES public.conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE public.delivery_work_generations (
  outbound_message_id uuid PRIMARY KEY,user_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>=0),
  FOREIGN KEY(outbound_message_id,user_id) REFERENCES public.outbound_messages(id,user_id) ON DELETE CASCADE
);
REVOKE ALL ON public.conversation_work_generations,public.delivery_work_generations
  FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler;
CREATE FUNCTION public.restore_work_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE retired bigint;
BEGIN
  IF TG_TABLE_NAME='conversation_work' THEN
    PERFORM 1 FROM public.conversations WHERE id=NEW.conversation_id AND user_id=NEW.user_id FOR UPDATE;
    SELECT generation INTO retired FROM public.conversation_work_generations WHERE conversation_id=NEW.conversation_id;
  ELSE
    PERFORM 1 FROM public.outbound_messages WHERE id=NEW.outbound_message_id AND user_id=NEW.user_id FOR UPDATE;
    SELECT generation INTO retired FROM public.delivery_work_generations WHERE outbound_message_id=NEW.outbound_message_id;
  END IF;
  NEW.lease_generation:=GREATEST(NEW.lease_generation,coalesce(retired,0));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.restore_work_generation() FROM PUBLIC;
CREATE TRIGGER restore_conversation_generation BEFORE INSERT ON public.conversation_work
  FOR EACH ROW EXECUTE FUNCTION public.restore_work_generation();
CREATE TRIGGER restore_delivery_generation BEFORE INSERT ON public.delivery_work
  FOR EACH ROW EXECUTE FUNCTION public.restore_work_generation();
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
    SELECT o.id FROM public.outbound_messages o WHERE o.status IN ('sent','uncertain','dead','cancelled','not_sent')
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

UPDATE public.system_state SET schema_version=22 WHERE id=1 AND schema_version=21;
