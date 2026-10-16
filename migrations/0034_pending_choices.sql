CREATE TABLE public.pending_choices(
 id uuid PRIMARY KEY,user_id uuid NOT NULL,conversation_id uuid NOT NULL,turn_id uuid NOT NULL,group_label text NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','consumed','cancelled','expired','superseded')),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outbound_id uuid,selected integer,result jsonb,
 UNIQUE(user_id,id),UNIQUE(user_id,turn_id,group_label,revision),
 FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_turn_content(user_id,turn_id) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,user_id) REFERENCES public.conversations(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(outbound_id,user_id) REFERENCES public.outbound_messages(id,user_id) ON DELETE CASCADE,
 CHECK((state IN('consumed','cancelled') AND selected IS NOT NULL AND result IS NOT NULL) OR (state NOT IN('consumed','cancelled') AND selected IS NULL AND result IS NULL))
);
CREATE TABLE public.pending_choice_options(
 user_id uuid NOT NULL,choice_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 5),label text NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
 key_version integer NOT NULL,token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),commands jsonb NOT NULL CHECK(jsonb_typeof(commands)='array' AND jsonb_array_length(commands)<=20),
 PRIMARY KEY(user_id,choice_id,ordinal),UNIQUE(token_hash),FOREIGN KEY(user_id,choice_id) REFERENCES public.pending_choices(user_id,id) ON DELETE CASCADE
);
ALTER TABLE public.pending_choices ENABLE ROW LEVEL SECURITY;ALTER TABLE public.pending_choices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pending_choice_options ENABLE ROW LEVEL SECURITY;ALTER TABLE public.pending_choice_options FORCE ROW LEVEL SECURITY;
CREATE POLICY choice_tenant ON public.pending_choices TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY choice_option_tenant ON public.pending_choice_options TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY choice_migrator ON public.pending_choices TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY choice_option_migrator ON public.pending_choice_options TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.pending_choices,public.pending_choice_options TO echo_worker;
GRANT UPDATE(state,selected,result,outbound_id) ON public.pending_choices TO echo_worker;
CREATE FUNCTION public.guard_choice_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.state<>'pending' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Choice terminal'; END IF;
 IF (NEW.id,NEW.user_id,NEW.conversation_id,NEW.turn_id,NEW.group_label,NEW.revision,NEW.expires_at,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.conversation_id,OLD.turn_id,OLD.group_label,OLD.revision,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'Choice immutable';END IF;
 IF OLD.outbound_id IS NOT NULL AND NEW.outbound_id IS DISTINCT FROM OLD.outbound_id THEN RAISE EXCEPTION 'Choice binding immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER choice_state_guard BEFORE UPDATE ON public.pending_choices FOR EACH ROW EXECUTE FUNCTION public.guard_choice_state();
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v33;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT public.account_erasure_counts_v33(target)||jsonb_build_object('pendingChoices',(SELECT count(*) FROM public.pending_choices WHERE user_id=target),'choiceOptions',(SELECT count(*) FROM public.pending_choice_options WHERE user_id=target)) $$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
UPDATE public.system_state SET schema_version=34 WHERE id=1 AND schema_version=33;
