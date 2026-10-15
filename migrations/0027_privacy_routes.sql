CREATE TABLE public.run_token_maps(
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 run_id uuid NOT NULL, ciphertext text NOT NULL CHECK(length(ciphertext)>0 AND length(ciphertext)<=2000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,run_id), CHECK(expires_at>created_at AND expires_at<=created_at+interval '2 hours')
);
ALTER TABLE public.run_token_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_token_maps FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_tenant ON public.run_token_maps TO echo_worker
 USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY privacy_migrator ON public.run_token_maps TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,DELETE ON public.run_token_maps TO echo_worker;
REVOKE ALL ON public.run_token_maps FROM PUBLIC,echo_gateway,echo_delivery,echo_scheduler;
CREATE INDEX privacy_expiry ON public.run_token_maps(expires_at);
CREATE OR REPLACE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('accounts',(SELECT count(*) FROM public.channel_accounts WHERE user_id=target),
    'conversations',(SELECT count(*) FROM public.conversations WHERE user_id=target),
    'inbound',(SELECT count(*) FROM public.inbound_events WHERE user_id=target),
    'outbound',(SELECT count(*) FROM public.outbound_messages WHERE user_id=target),
    'receipts',(SELECT count(*) FROM public.processing_receipts WHERE user_id=target),
    'attempts',(SELECT count(*) FROM public.delivery_attempts WHERE user_id=target),
    'conversationWork',(SELECT count(*) FROM public.conversation_work WHERE user_id=target),
    'deliveryWork',(SELECT count(*) FROM public.delivery_work WHERE user_id=target),
    'tasks',(SELECT count(*) FROM public.work_items WHERE user_id=target),
    'taskEvents',(SELECT count(*) FROM public.work_item_events WHERE user_id=target),
    'taskReceipts',(SELECT count(*) FROM public.task_command_receipts WHERE user_id=target),'privacyMaps',(SELECT count(*) FROM public.run_token_maps WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;

CREATE FUNCTION public.retain_privacy_maps(batch integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;
BEGIN
 IF batch IS NULL OR batch<1 OR batch>100 THEN RAISE EXCEPTION 'Invalid cleanup batch'; END IF;
 PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup fenced'; END IF;
 WITH due AS(SELECT user_id,run_id FROM public.run_token_maps WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT batch FOR UPDATE SKIP LOCKED)
 DELETE FROM public.run_token_maps m USING due d WHERE m.user_id=d.user_id AND m.run_id=d.run_id;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.retain_privacy_maps(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retain_privacy_maps(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=27 WHERE id=1 AND schema_version=26;
