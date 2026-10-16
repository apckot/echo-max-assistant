CREATE TABLE public.turn_groups(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,label text NOT NULL CHECK(label~'^g[1-9][0-9]{0,2}(:g[1-9][0-9]{0,2})*$'),
 outcome text NOT NULL CHECK(outcome IN('applied','no_change','rejected','blocked','choice','respond')),
 receipt_id uuid,result jsonb NOT NULL CHECK(octet_length(result::text)<=1000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,turn_id,label),
 FOREIGN KEY(user_id,turn_id) REFERENCES public.accepted_decisions(user_id,turn_id) ON DELETE CASCADE,
 FOREIGN KEY(receipt_id,user_id) REFERENCES public.task_command_receipts(id,user_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.turn_response_intents(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','finalized')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,turn_id),
 FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_turn_content(user_id,turn_id) ON DELETE CASCADE
);
ALTER TABLE public.turn_groups ENABLE ROW LEVEL SECURITY;ALTER TABLE public.turn_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turn_response_intents ENABLE ROW LEVEL SECURITY;ALTER TABLE public.turn_response_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY group_tenant ON public.turn_groups TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY intent_tenant ON public.turn_response_intents TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY group_migrator ON public.turn_groups TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY intent_migrator ON public.turn_response_intents TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.turn_groups,public.turn_response_intents TO echo_worker;
GRANT UPDATE(revision,state) ON public.turn_response_intents TO echo_worker;
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v29;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.account_erasure_counts_v29(target)||jsonb_build_object('turnGroups',(SELECT count(*) FROM public.turn_groups WHERE user_id=target),'responseIntents',(SELECT count(*) FROM public.turn_response_intents WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
UPDATE public.system_state SET schema_version=30 WHERE id=1 AND schema_version=29;
