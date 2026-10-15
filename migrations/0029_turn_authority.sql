CREATE TABLE public.agent_runs(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,run_id uuid NOT NULL,
 source_event_id uuid,conversation_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 profile_digest text NOT NULL CHECK(profile_digest~'^[a-f0-9]{64}$'),
 phase text NOT NULL CHECK(phase IN('claimed','started','accepted','failed')),
 prepared_context jsonb, context_digest text GENERATED ALWAYS AS(encode(digest(prepared_context::text,'sha256'),'hex')) STORED, failure_code text CHECK(length(failure_code)<=80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,turn_id),UNIQUE(run_id,user_id),UNIQUE(run_id,user_id,turn_id),UNIQUE(turn_id,user_id,conversation_id),
 FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_turn_content(user_id,turn_id) ON DELETE CASCADE,
 FOREIGN KEY(source_event_id,user_id,conversation_id) REFERENCES public.inbound_events(id,user_id,conversation_id) ON DELETE SET NULL(source_event_id),
 FOREIGN KEY(conversation_id,user_id) REFERENCES public.conversations(id,user_id) ON DELETE CASCADE,
 CHECK(prepared_context IS NULL OR octet_length(prepared_context::text)<=300000)
);
CREATE TABLE public.accepted_decisions(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,run_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision=1),
 plan jsonb NOT NULL CHECK(octet_length(plan::text)<=1000000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,turn_id),FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_runs(user_id,turn_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,user_id,turn_id) REFERENCES public.agent_runs(run_id,user_id,turn_id)
);
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE public.agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accepted_decisions ENABLE ROW LEVEL SECURITY;ALTER TABLE public.accepted_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY runs_tenant ON public.agent_runs TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY decisions_tenant ON public.accepted_decisions TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY runs_migrator ON public.agent_runs TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY decisions_migrator ON public.accepted_decisions TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.agent_runs,public.accepted_decisions TO echo_worker;
GRANT UPDATE(generation,phase,prepared_context,failure_code) ON public.agent_runs TO echo_worker;
CREATE FUNCTION public.agent_run_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.phase IN('accepted','failed') AND (NEW.phase<>OLD.phase OR NEW.prepared_context IS DISTINCT FROM OLD.prepared_context OR NEW.failure_code IS DISTINCT FROM OLD.failure_code) THEN RAISE EXCEPTION 'Terminal agent run'; END IF;
 IF OLD.prepared_context IS NOT NULL AND NEW.prepared_context IS DISTINCT FROM OLD.prepared_context THEN RAISE EXCEPTION 'Immutable agent context'; END IF;
 IF OLD.phase='started' AND NEW.phase='claimed' THEN RAISE EXCEPTION 'No provider redispatch'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.agent_run_immutable() FROM PUBLIC;
CREATE TRIGGER agent_run_immutable BEFORE UPDATE ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION public.agent_run_immutable();
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v28;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.account_erasure_counts_v28(target)||jsonb_build_object('agentRuns',(SELECT count(*) FROM public.agent_runs WHERE user_id=target),'acceptedDecisions',(SELECT count(*) FROM public.accepted_decisions WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
UPDATE public.system_state SET schema_version=29 WHERE id=1 AND schema_version=28;
