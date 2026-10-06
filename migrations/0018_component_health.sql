CREATE TABLE public.integration_health (
  component text PRIMARY KEY CHECK(component='max_subscription'),
  status text NOT NULL CHECK(status IN ('healthy','degraded','critical')),
  failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
  secret_version text,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.integration_health FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;

-- Aggregate-only projection: runtime roles never receive tenant content or IDs.
CREATE FUNCTION public.component_health() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT jsonb_build_object(
  'schemaVersion',s.schema_version,'restoreFence',s.restore_fence,
  'migrations',(SELECT coalesce(jsonb_object_agg(name,checksum),'{}'::jsonb) FROM public.schema_migrations),
  'queue',jsonb_build_object('depth',(SELECT count(*) FROM public.inbound_events e JOIN public.conversations c
    ON c.id=e.conversation_id WHERE e.sequence>=c.next_apply_sequence),
    'lagSeconds',(SELECT coalesce(extract(epoch FROM clock_timestamp()-min(e.received_at)),0) FROM public.inbound_events e
      JOIN public.conversations c ON c.id=e.conversation_id WHERE e.sequence>=c.next_apply_sequence),
    'expiredLeases',(SELECT count(*) FROM public.conversation_work WHERE state='leased' AND lease_until<clock_timestamp())),
  'delivery',jsonb_build_object(
    'pending',(SELECT count(*) FROM public.outbound_messages o JOIN public.conversations c ON c.id=o.conversation_id
      JOIN public.inbound_events e ON e.id=o.source_inbound_event_id
      WHERE o.status IN ('pending','retry') AND c.state='active' AND e.sequence>c.delivery_cancelled_through_sequence),
    'cancelled',(SELECT count(*) FROM public.outbound_messages o JOIN public.conversations c ON c.id=o.conversation_id
      JOIN public.inbound_events e ON e.id=o.source_inbound_event_id WHERE o.status='cancelled' OR
      (o.status IN ('pending','retry') AND (c.state='stopped' OR e.sequence<=c.delivery_cancelled_through_sequence))),
    'uncertain',(SELECT count(*) FROM public.outbound_messages WHERE status='uncertain'),
    'expiredLeases',(SELECT count(*) FROM public.delivery_work WHERE state='leased' AND lease_until<clock_timestamp())),
  'subscription',coalesce((SELECT jsonb_build_object('status',status,'failures',failures,'checkedAt',checked_at)
    FROM public.integration_health WHERE component='max_subscription'),'{"status":"unknown"}'::jsonb),
  'backup','unknown','deletion',jsonb_build_object('pending',(SELECT count(*) FROM public.users WHERE status='deleting')))
FROM public.system_state s WHERE s.id=1
$$;
REVOKE ALL ON FUNCTION public.component_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.component_health() TO echo_gateway, echo_scheduler;
UPDATE public.system_state SET schema_version=18 WHERE id=1 AND schema_version=17;
