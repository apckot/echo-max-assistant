ALTER FUNCTION public.valid_processing_result(jsonb) RENAME TO valid_pre_assistant_processing_result;
CREATE FUNCTION public.valid_processing_result(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value->>'receiptType'<>'assistant_turn_v1' THEN RETURN public.valid_pre_assistant_processing_result(value); END IF;
 IF NOT coalesce(jsonb_typeof(value)='object' AND value-ARRAY['receiptType','receiptVersion','turnId','responseRevision','messages']='{}'::jsonb
  AND value->'receiptVersion'='1'::jsonb AND value->'responseRevision'='1'::jsonb
  AND jsonb_typeof(value->'turnId')='string' AND value->>'turnId'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND value->>'turnId'<>'00000000-0000-0000-0000-000000000000' AND jsonb_typeof(value->'messages')='array',false) THEN RETURN false; END IF;
 IF jsonb_array_length(value->'messages')>1 THEN RETURN false; END IF;
 RETURN public.valid_foundation_processing_result(jsonb_build_object('receiptType','foundation_echo','receiptVersion',1,'messages',value->'messages'));
END $$;
REVOKE ALL ON FUNCTION public.valid_processing_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_processing_result(jsonb) TO echo_worker;
ALTER TABLE public.processing_receipts DROP CONSTRAINT processing_receipts_result_check;
ALTER TABLE public.processing_receipts DROP CONSTRAINT processing_receipts_receipt_type_check;
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_receipt_type_check CHECK(receipt_type IN('foundation_echo','task_commands_v1','assistant_turn_v1'));
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_result_check CHECK(public.valid_processing_result(result) IS TRUE);
ALTER TABLE public.processing_receipts ADD COLUMN assistant_turn_id uuid GENERATED ALWAYS AS(CASE WHEN receipt_type='assistant_turn_v1' THEN (result->>'turnId')::uuid END) STORED;
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_assistant_fk FOREIGN KEY(user_id,assistant_turn_id) REFERENCES public.agent_turn_keys(user_id,turn_id);
ALTER TABLE public.outbound_messages ADD COLUMN assistant_turn_id uuid;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_assistant_fk FOREIGN KEY(user_id,assistant_turn_id) REFERENCES public.agent_turn_keys(user_id,turn_id);
ALTER TABLE public.outbound_messages DROP CONSTRAINT outbound_messages_dedupe_shape;
ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_dedupe_shape CHECK(
 (assistant_turn_id IS NULL AND dedupe_key='response:'||source_inbound_event_id::text||':'||message_index::text||':v1') OR
 (assistant_turn_id IS NOT NULL AND message_index=0 AND dedupe_key='turn:'||assistant_turn_id::text||':final:v1'));
CREATE UNIQUE INDEX outbound_assistant_once ON public.outbound_messages(user_id,assistant_turn_id) WHERE assistant_turn_id IS NOT NULL;
GRANT INSERT(assistant_turn_id) ON public.outbound_messages TO echo_worker;
UPDATE public.system_state SET schema_version=31 WHERE id=1 AND schema_version=30;
