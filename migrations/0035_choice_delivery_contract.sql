ALTER FUNCTION public.valid_outbound_payload(jsonb) RENAME TO valid_plain_outbound_payload;
CREATE FUNCTION public.valid_outbound_payload(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE button jsonb;ref jsonb;BEGIN
 IF value->>'kind'<>'choice' THEN RETURN public.valid_plain_outbound_payload(value);END IF;
 IF NOT coalesce(jsonb_typeof(value)='object' AND value-ARRAY['version','kind','text','buttons']='{}'::jsonb AND value->'version'='1'::jsonb AND jsonb_typeof(value->'text')='string' AND jsonb_typeof(value->'buttons')='array',false) THEN RETURN false;END IF;
 IF jsonb_array_length(value->'buttons') NOT BETWEEN 3 AND 60 THEN RETURN false;END IF;
 FOR button IN SELECT jsonb_array_elements(value->'buttons') LOOP
 ref=button->'ref';IF NOT coalesce(jsonb_typeof(button)='object' AND button-ARRAY['label','ref']='{}'::jsonb AND jsonb_typeof(button->'label')='string' AND length(button->>'label') BETWEEN 1 AND 128 AND jsonb_typeof(ref)='object' AND ref-ARRAY['choiceId','revision','option','keyVersion']='{}'::jsonb AND ref->>'choiceId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND (ref->>'revision')~'^[1-9][0-9]{0,8}$' AND (ref->>'keyVersion')~'^[1-9][0-9]{0,8}$' AND (ref->>'option')~'^[0-5]$',false) THEN RETURN false;END IF;
 END LOOP;RETURN true;END $$;
REVOKE ALL ON FUNCTION public.valid_outbound_payload(jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.valid_outbound_payload(jsonb) TO echo_worker,echo_delivery;
ALTER FUNCTION public.valid_processing_result(jsonb) RENAME TO valid_pre_choice_processing_result;
CREATE FUNCTION public.valid_processing_result(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE message jsonb;clean jsonb='[]';BEGIN
 IF value->>'receiptType'<>'assistant_turn_v1' THEN RETURN public.valid_pre_choice_processing_result(value);END IF;
 IF jsonb_typeof(value->'messages') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOR message IN SELECT jsonb_array_elements(value->'messages') LOOP
 IF public.valid_outbound_payload(message) IS NOT TRUE THEN RETURN false;END IF;
 clean=clean||jsonb_build_array(jsonb_build_object('version',1,'kind','text','text',message->>'text'));
 END LOOP;
 RETURN public.valid_pre_choice_processing_result(jsonb_set(value,'{messages}',clean));END $$;
REVOKE ALL ON FUNCTION public.valid_processing_result(jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.valid_processing_result(jsonb) TO echo_worker;
ALTER TABLE public.processing_receipts DROP CONSTRAINT processing_receipts_result_check;
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_result_check CHECK(public.valid_processing_result(result) IS TRUE);
DO $$ DECLARE constraint_name text;BEGIN SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='public.outbound_messages'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%valid_plain_outbound_payload%';EXECUTE format('ALTER TABLE public.outbound_messages DROP CONSTRAINT %I',constraint_name);END $$;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_payload_check CHECK(public.valid_outbound_payload(payload) IS TRUE);
ALTER TABLE public.pending_choices ADD COLUMN receipt_id uuid;
ALTER TABLE public.pending_choices ADD CONSTRAINT choice_task_receipt_fk FOREIGN KEY(receipt_id,user_id) REFERENCES public.task_command_receipts(id,user_id) DEFERRABLE INITIALLY DEFERRED;
GRANT UPDATE(receipt_id) ON public.pending_choices TO echo_worker;
ALTER TABLE public.outbound_messages ADD COLUMN choice_id uuid;
ALTER TABLE public.outbound_messages ADD COLUMN choice_revision integer;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_choice_fk FOREIGN KEY(user_id,choice_id) REFERENCES public.pending_choices(user_id,id) ON DELETE CASCADE;
ALTER TABLE public.outbound_messages DROP CONSTRAINT outbound_messages_dedupe_shape;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_dedupe_shape CHECK(
 (assistant_turn_id IS NULL AND choice_id IS NULL AND choice_revision IS NULL AND dedupe_key='response:'||source_inbound_event_id::text||':'||message_index::text||':v1') OR
 (assistant_turn_id IS NOT NULL AND choice_id IS NULL AND choice_revision IS NULL AND message_index=0 AND dedupe_key='turn:'||assistant_turn_id::text||':final:v1') OR
 (assistant_turn_id IS NULL AND choice_id IS NOT NULL AND choice_revision>0 AND message_index=0 AND dedupe_key='choice:'||choice_id::text||':'||choice_revision::text||':result:v1'));
CREATE UNIQUE INDEX outbound_choice_once ON public.outbound_messages(user_id,choice_id,choice_revision) WHERE choice_id IS NOT NULL;
GRANT INSERT(choice_id,choice_revision) ON public.outbound_messages TO echo_worker;

DO $$ DECLARE constraint_name text;BEGIN SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='public.inbound_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(payload)%';EXECUTE format('ALTER TABLE public.inbound_events DROP CONSTRAINT %I',constraint_name);END $$;
ALTER TABLE public.inbound_events ADD CONSTRAINT inbound_events_payload_check CHECK (coalesce((
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
      OR (kind = 'button' AND payload - ARRAY['kind', 'callbackPayload', 'replyToMessageId','callbackMessageId'] = '{}'::jsonb
        AND jsonb_typeof(payload->'callbackPayload') = 'string' AND (NOT payload?'callbackMessageId' OR (jsonb_typeof(payload->'callbackMessageId')='string' AND length(payload->>'callbackMessageId')>0)))
      OR (kind = 'lifecycle' AND payload - ARRAY['kind', 'lifecycleType'] = '{}'::jsonb
        AND payload->>'lifecycleType' IN ('started', 'stopped'))
    ) AND (NOT payload ? 'replyToMessageId' OR
      (jsonb_typeof(payload->'replyToMessageId') = 'string' AND length(payload->>'replyToMessageId') > 0))
  ), false));
UPDATE public.system_state SET schema_version=35 WHERE id=1 AND schema_version=34;

CREATE FUNCTION public.verified_choice_delivery(choice uuid,message_id text,conv uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.pending_choices c JOIN public.delivery_attempts d ON d.user_id=c.user_id AND d.outbound_message_id=c.outbound_id WHERE c.id=choice AND c.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND c.conversation_id=conv AND d.phase='completed' AND d.certainty='sent' AND d.external_message_id=message_id)
$$;
REVOKE ALL ON FUNCTION public.verified_choice_delivery(uuid,text,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.verified_choice_delivery(uuid,text,uuid) TO echo_worker;
