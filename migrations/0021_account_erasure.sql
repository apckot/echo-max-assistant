CREATE TABLE public.account_deletions (
  operation_id uuid PRIMARY KEY,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor text NOT NULL CHECK(actor IN ('operator','self_service')),
  reason text NOT NULL CHECK(reason='privacy_request'),
  status text NOT NULL CHECK(status IN ('pending','completed')),
  counts jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK((status='pending' AND user_id IS NOT NULL AND completed_at IS NULL) OR
    (status='completed' AND user_id IS NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX account_deletions_pending_user ON public.account_deletions(user_id) WHERE status='pending';
REVOKE ALL ON public.account_deletions FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler;
GRANT SELECT ON public.account_deletions TO echo_scheduler;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('accounts',(SELECT count(*) FROM public.channel_accounts WHERE user_id=target),
    'conversations',(SELECT count(*) FROM public.conversations WHERE user_id=target),
    'inbound',(SELECT count(*) FROM public.inbound_events WHERE user_id=target),
    'outbound',(SELECT count(*) FROM public.outbound_messages WHERE user_id=target),
    'receipts',(SELECT count(*) FROM public.processing_receipts WHERE user_id=target),
    'attempts',(SELECT count(*) FROM public.delivery_attempts WHERE user_id=target),
    'conversationWork',(SELECT count(*) FROM public.conversation_work WHERE user_id=target),
    'deliveryWork',(SELECT count(*) FROM public.delivery_work WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
CREATE FUNCTION public.erase_account(target uuid,operation uuid,actor_code text,reason_code text,mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job public.account_deletions%ROWTYPE; counts jsonb; account record; user_status text;
BEGIN
  IF target IS NULL OR operation IS NULL OR target='00000000-0000-0000-0000-000000000000'::uuid OR
    operation='00000000-0000-0000-0000-000000000000'::uuid OR actor_code IS NULL OR reason_code IS NULL OR mode IS NULL OR
    actor_code NOT IN ('operator','self_service') OR reason_code<>'privacy_request' OR mode NOT IN ('preview','begin','finish') THEN
    RAISE EXCEPTION 'Invalid erasure request' USING ERRCODE='22023'; END IF;
  IF mode='preview' THEN RETURN jsonb_build_object('status','preview','counts',public.account_erasure_counts(target)); END IF;
  PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Erasure fenced'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('erasure:'||operation::text,0));
  SELECT * INTO job FROM public.account_deletions WHERE operation_id=operation FOR UPDATE;
  IF FOUND THEN
    IF job.actor<>actor_code OR job.reason<>reason_code THEN RAISE EXCEPTION 'Erasure operation conflict'; END IF;
    IF job.status='completed' THEN RETURN jsonb_build_object('status','completed','counts',job.counts); END IF;
    IF job.user_id<>target THEN RAISE EXCEPTION 'Erasure operation conflict'; END IF;
  END IF;
  -- Same order as resolver: MAX identity advisory locks before the user-row lock.
  FOR account IN SELECT external_user_id FROM public.channel_accounts WHERE user_id=target ORDER BY external_user_id LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('max:user:'||account.external_user_id,0));
  END LOOP;
  SELECT status INTO user_status FROM public.users WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','absent','counts',public.account_erasure_counts(target)); END IF;
  IF mode='begin' THEN
    counts:=public.account_erasure_counts(target);
    INSERT INTO public.account_deletions(operation_id,user_id,actor,reason,status,counts)
      VALUES(operation,target,actor_code,reason_code,'pending',counts) ON CONFLICT(operation_id) DO NOTHING;
    UPDATE public.users SET status='deleting',updated_at=clock_timestamp() WHERE id=target;
    UPDATE public.channel_accounts SET state='stopped',updated_at=clock_timestamp() WHERE user_id=target;
    UPDATE public.conversations SET state='stopped',updated_at=clock_timestamp() WHERE user_id=target;
    UPDATE public.conversation_work SET state='dead',lease_owner=NULL,lease_until=NULL,lease_generation=lease_generation+1 WHERE user_id=target;
    UPDATE public.outbound_messages SET status='cancelled',updated_at=clock_timestamp()
      WHERE user_id=target AND status IN ('pending','retry','not_sent');
    UPDATE public.delivery_work w SET state='cancelled',lease_owner=NULL,lease_until=NULL,
      lease_generation=lease_generation+1,updated_at=clock_timestamp()
      WHERE w.user_id=target AND NOT EXISTS(SELECT 1 FROM public.outbound_messages o WHERE o.id=w.outbound_message_id AND o.status='sending');
    RETURN jsonb_build_object('status','pending','counts',counts);
  END IF;
  IF job.operation_id IS NULL OR user_status<>'deleting' THEN RAISE EXCEPTION 'Erasure not started'; END IF;
  -- All user admission/processing locks precede work locks. Sending facts remain
  -- recoverable: a crashed sender must become terminal through certainty recovery.
  PERFORM 1 FROM public.channel_accounts WHERE user_id=target ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.conversations WHERE user_id=target ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.outbound_messages WHERE user_id=target AND status='sending') THEN
    RETURN jsonb_build_object('status','waiting','counts',job.counts); END IF;
  PERFORM set_config('app.privacy_erasure','on',true);
  DELETE FROM public.delivery_attempts WHERE user_id=target;
  PERFORM set_config('app.privacy_erasure','off',true);
  DELETE FROM public.delivery_work WHERE user_id=target;
  DELETE FROM public.outbound_messages WHERE user_id=target;
  DELETE FROM public.processing_receipts WHERE user_id=target;
  DELETE FROM public.conversation_work WHERE user_id=target;
  DELETE FROM public.inbound_events WHERE user_id=target;
  DELETE FROM public.conversations WHERE user_id=target;
  DELETE FROM public.channel_accounts WHERE user_id=target;
  -- Remove identity link before the FK action, keeping the audit constraint valid.
  UPDATE public.account_deletions SET user_id=NULL,status='completed',completed_at=clock_timestamp() WHERE operation_id=operation;
  DELETE FROM public.users WHERE id=target;
  RETURN jsonb_build_object('status','completed','counts',job.counts);
END $$;
REVOKE ALL ON FUNCTION public.erase_account(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_account(uuid,uuid,text,text,text) TO echo_scheduler;
UPDATE public.system_state SET schema_version=21 WHERE id=1 AND schema_version=20;
