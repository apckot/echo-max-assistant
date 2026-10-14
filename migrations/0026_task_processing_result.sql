ALTER FUNCTION public.valid_processing_result(jsonb) RENAME TO valid_foundation_processing_result;
CREATE FUNCTION public.valid_processing_result(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value->>'receiptType'='foundation_echo' THEN RETURN public.valid_foundation_processing_result(value); END IF;
 IF NOT coalesce(jsonb_typeof(value)='object'
  AND value - ARRAY['receiptType','receiptVersion','taskReceiptId','messages']='{}'::jsonb
  AND value->'receiptType'='"task_commands_v1"'::jsonb AND value->'receiptVersion'='1'::jsonb
  AND jsonb_typeof(value->'taskReceiptId')='string'
  AND value->>'taskReceiptId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND value->>'taskReceiptId'<>'00000000-0000-0000-0000-000000000000'
  AND jsonb_typeof(value->'messages')='array',false) THEN RETURN false; END IF;
 IF jsonb_array_length(value->'messages')<>1 THEN RETURN false; END IF;
 RETURN public.valid_foundation_processing_result(jsonb_build_object('receiptType','foundation_echo','receiptVersion',1,'messages',value->'messages'));
END $$;
REVOKE ALL ON FUNCTION public.valid_processing_result(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_processing_result(jsonb) TO echo_worker;
-- The old CHECK tracks the renamed function OID: replace it explicitly.
ALTER TABLE public.processing_receipts DROP CONSTRAINT processing_receipts_result_check;
ALTER TABLE public.processing_receipts DROP CONSTRAINT processing_receipts_receipt_type_check;
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_receipt_type_check CHECK(receipt_type IN ('foundation_echo','task_commands_v1'));
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_result_check CHECK(public.valid_processing_result(result) IS TRUE);
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_result_contract CHECK(result->>'receiptType'=receipt_type AND result->'receiptVersion'=to_jsonb(receipt_version));
ALTER TABLE public.processing_receipts ADD COLUMN task_receipt_id uuid GENERATED ALWAYS AS
 (CASE WHEN receipt_type='task_commands_v1' THEN (result->>'taskReceiptId')::uuid END) STORED;
ALTER TABLE public.processing_receipts ADD CONSTRAINT processing_receipts_task_fk FOREIGN KEY(task_receipt_id,user_id)
 REFERENCES public.task_command_receipts(id,user_id) DEFERRABLE INITIALLY DEFERRED;
UPDATE public.system_state SET schema_version=26 WHERE id=1 AND schema_version=25;
