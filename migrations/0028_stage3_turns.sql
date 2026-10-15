CREATE TABLE public.agent_turn_keys(
 user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 turn_id uuid NOT NULL, key_version integer NOT NULL CHECK(key_version>0),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 completed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,turn_id),UNIQUE(user_id,key_version,source_digest)
);
CREATE TABLE public.agent_turn_content(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,source_event_id uuid,source_conversation_id uuid,
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=300000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finalized_at timestamptz,
 PRIMARY KEY(user_id,turn_id),FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_turn_keys(user_id,turn_id) ON DELETE CASCADE,
 FOREIGN KEY(source_event_id,user_id,source_conversation_id) REFERENCES public.inbound_events(id,user_id,conversation_id) ON DELETE SET NULL(source_event_id,source_conversation_id), CHECK((source_event_id IS NULL)=(source_conversation_id IS NULL))
);
CREATE TABLE public.context_anchors(
 user_id uuid NOT NULL,conversation_id uuid NOT NULL,outbound_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('reply','list')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,outbound_id),FOREIGN KEY(outbound_id,user_id) REFERENCES public.outbound_messages(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,user_id) REFERENCES public.conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE public.context_anchor_tasks(
 user_id uuid NOT NULL,outbound_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 100),task_id uuid NOT NULL,task_version integer NOT NULL CHECK(task_version>0),
 PRIMARY KEY(user_id,outbound_id,ordinal),FOREIGN KEY(user_id,outbound_id) REFERENCES public.context_anchors(user_id,outbound_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,user_id) REFERENCES public.work_items(id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.agent_turn_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turn_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turn_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_turn_content FORCE ROW LEVEL SECURITY;
ALTER TABLE public.context_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_anchors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.context_anchor_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_anchor_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY turn_keys_tenant ON public.agent_turn_keys TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY turn_content_tenant ON public.agent_turn_content TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY anchors_tenant ON public.context_anchors TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY anchor_tasks_tenant ON public.context_anchor_tasks TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY turn_keys_migrator ON public.agent_turn_keys TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY turn_content_migrator ON public.agent_turn_content TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY anchors_migrator ON public.context_anchors TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY anchor_tasks_migrator ON public.context_anchor_tasks TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.agent_turn_keys,public.agent_turn_content,public.context_anchors,public.context_anchor_tasks TO echo_worker;
GRANT UPDATE(completed) ON public.agent_turn_keys TO echo_worker;
GRANT UPDATE(finalized_at) ON public.agent_turn_content TO echo_worker;
-- Read delivery facts through a bounded tenant projection, without granting access to delivery internals.
CREATE FUNCTION public.delivered_context(message_id text,conv uuid) RETURNS TABLE(outbound_id uuid,kind text,tasks jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.outbound_id,a.kind,jsonb_agg(jsonb_build_object('id',t.task_id,'version',t.task_version) ORDER BY t.ordinal)
 FROM public.context_anchors a JOIN public.context_anchor_tasks t USING(user_id,outbound_id)
 WHERE a.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND a.conversation_id=conv
 AND EXISTS(SELECT 1 FROM public.delivery_attempts d WHERE d.outbound_message_id=a.outbound_id AND d.user_id=a.user_id AND d.phase='completed' AND d.certainty='sent' AND d.external_message_id=message_id)
 GROUP BY a.outbound_id,a.kind LIMIT 2
$$;
REVOKE ALL ON FUNCTION public.delivered_context(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivered_context(text,uuid) TO echo_worker;
CREATE FUNCTION public.delivered_history(conv uuid,source_at timestamptz) RETURNS TABLE(user_text text,assistant_text text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.snapshot->'source'->>'text',o.payload->>'text'
 FROM public.agent_turn_content c JOIN public.outbound_messages o ON o.source_inbound_event_id=c.source_event_id AND o.user_id=c.user_id
 WHERE c.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND o.conversation_id=conv
 AND o.created_at>=source_at-interval '48 hours' AND o.created_at<=source_at
 AND EXISTS(SELECT 1 FROM public.delivery_attempts d WHERE d.outbound_message_id=o.id AND d.user_id=o.user_id AND d.phase='completed' AND d.certainty='sent')
 AND c.snapshot->'source'->>'text' IS NOT NULL ORDER BY o.created_at DESC,o.id DESC LIMIT 12
$$;
REVOKE ALL ON FUNCTION public.delivered_history(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivered_history(uuid,timestamptz) TO echo_worker;
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v27;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.account_erasure_counts_v27(target)||jsonb_build_object('agentTurns',(SELECT count(*) FROM public.agent_turn_keys WHERE user_id=target),'agentContent',(SELECT count(*) FROM public.agent_turn_content WHERE user_id=target),'contextAnchors',(SELECT count(*) FROM public.context_anchors WHERE user_id=target),'contextAnchorTasks',(SELECT count(*) FROM public.context_anchor_tasks WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
CREATE INDEX agent_content_retention ON public.agent_turn_content(finalized_at);
CREATE INDEX context_anchor_retention ON public.context_anchors(created_at);
CREATE FUNCTION public.retain_agent_content(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer; m integer;
BEGIN
 IF batch IS NULL OR batch<1 OR batch>100 THEN RAISE EXCEPTION 'Invalid cleanup batch'; END IF;
 PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup fenced'; END IF;
 WITH due AS(SELECT user_id,turn_id FROM public.agent_turn_content WHERE finalized_at<clock_timestamp()-interval '30 days' ORDER BY finalized_at LIMIT batch FOR UPDATE SKIP LOCKED)
 DELETE FROM public.agent_turn_content c USING due d WHERE c.user_id=d.user_id AND c.turn_id=d.turn_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 WITH due AS(SELECT user_id,outbound_id FROM public.context_anchors WHERE created_at<clock_timestamp()-interval '30 days' ORDER BY created_at LIMIT batch FOR UPDATE SKIP LOCKED)
 DELETE FROM public.context_anchors a USING due d WHERE a.user_id=d.user_id AND a.outbound_id=d.outbound_id;
 GET DIAGNOSTICS m=ROW_COUNT; RETURN n+m;
END $$;
REVOKE ALL ON FUNCTION public.retain_agent_content(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retain_agent_content(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=28 WHERE id=1 AND schema_version=27;
