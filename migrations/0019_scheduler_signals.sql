CREATE TABLE public.operations_alerts (
  code text PRIMARY KEY CHECK(code='max_subscription_critical'),
  raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
REVOKE ALL ON public.operations_alerts FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler;
GRANT SELECT,INSERT,UPDATE ON public.integration_health,public.operations_alerts TO echo_scheduler;
CREATE FUNCTION public.scheduler_safety_scan(batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE conversations integer; deliveries integer;
BEGIN
  IF batch_limit IS NULL OR batch_limit<1 OR batch_limit>100 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Scheduler fenced'; END IF;
  -- Claim paths own expired-lease recovery and certainty. Only wake durable candidates here.
  SELECT count(*) INTO conversations FROM (SELECT 1 FROM public.conversation_work
    WHERE (state IN ('ready','retry') AND available_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp())
    LIMIT batch_limit) q;
  SELECT count(*) INTO deliveries FROM (SELECT 1 FROM public.delivery_work
    WHERE (state IN ('ready','retry') AND available_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp())
    LIMIT batch_limit) q;
  IF conversations>0 THEN PERFORM pg_catalog.pg_notify('conversation_work_wake',''); END IF;
  IF deliveries>0 THEN PERFORM pg_catalog.pg_notify('delivery_work_wake',''); END IF;
  RETURN jsonb_build_object('conversation',conversations,'delivery',deliveries);
END $$;
REVOKE ALL ON FUNCTION public.scheduler_safety_scan(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scheduler_safety_scan(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=19 WHERE id=1 AND schema_version=18;
