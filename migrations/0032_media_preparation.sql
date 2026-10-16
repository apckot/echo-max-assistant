CREATE TABLE public.audio_consents(
 user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,revision integer NOT NULL CHECK(revision>0),
 policy_version integer NOT NULL CHECK(policy_version>0),processor text NOT NULL CHECK(processor='openai'),
 granted boolean NOT NULL,disclosure_accepted boolean NOT NULL,own_dictation boolean NOT NULL,
 no_prohibited_data boolean NOT NULL,no_unconsented_third_parties boolean NOT NULL,revoked boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.media_preparations(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN('loading','prepared','stt_started','transcribed','failed')),
 consent_revision integer NOT NULL,policy_version integer NOT NULL,checksum text CHECK(checksum~'^[a-f0-9]{64}$'),
 duration_ms numeric CHECK(duration_ms>0 AND duration_ms<=1200000),byte_count integer CHECK(byte_count>0 AND byte_count<=25000000),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 minutes',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 failure_code text CHECK(length(failure_code)<=80),bytes_released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,turn_id),FOREIGN KEY(user_id,turn_id) REFERENCES public.agent_turn_content(user_id,turn_id) ON DELETE CASCADE,
 CHECK(expires_at<=created_at+interval '30 minutes')
);
ALTER TABLE public.audio_consents ENABLE ROW LEVEL SECURITY;ALTER TABLE public.audio_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.media_preparations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.media_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_tenant ON public.audio_consents TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY media_tenant ON public.media_preparations TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY consent_migrator ON public.audio_consents TO echo_migrator USING(true) WITH CHECK(true);
CREATE POLICY media_migrator ON public.media_preparations TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON public.audio_consents TO echo_worker;
GRANT SELECT,INSERT ON public.media_preparations TO echo_worker;
GRANT UPDATE(phase,checksum,duration_ms,byte_count,failure_code,bytes_released) ON public.media_preparations TO echo_worker;
CREATE FUNCTION public.media_phase_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.phase IN('stt_started','transcribed','failed') AND NEW.phase NOT IN('transcribed','failed') THEN RAISE EXCEPTION 'No STT redispatch'; END IF;
 IF OLD.phase IN('transcribed','failed') AND NEW.phase<>OLD.phase THEN RAISE EXCEPTION 'Terminal media'; END IF;
 IF OLD.checksum IS NOT NULL AND NEW.checksum IS DISTINCT FROM OLD.checksum THEN RAISE EXCEPTION 'Immutable media checksum'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.media_phase_immutable() FROM PUBLIC;
CREATE TRIGGER media_phase_immutable BEFORE UPDATE ON public.media_preparations FOR EACH ROW EXECUTE FUNCTION public.media_phase_immutable();
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v30;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.account_erasure_counts_v30(target)||jsonb_build_object('audioConsents',(SELECT count(*) FROM public.audio_consents WHERE user_id=target),'mediaPreparations',(SELECT count(*) FROM public.media_preparations WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
CREATE FUNCTION public.expire_media_preparations(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;BEGIN
 IF batch IS NULL OR batch<1 OR batch>100 THEN RAISE EXCEPTION 'Invalid cleanup batch'; END IF;
 PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup fenced'; END IF;
 WITH due AS(SELECT user_id,turn_id FROM public.media_preparations WHERE expires_at<=clock_timestamp() AND phase IN('loading','prepared','stt_started') ORDER BY expires_at LIMIT batch FOR UPDATE SKIP LOCKED)
 UPDATE public.media_preparations m SET phase='failed',failure_code='expired',bytes_released=true FROM due d WHERE m.user_id=d.user_id AND m.turn_id=d.turn_id;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END $$;
REVOKE ALL ON FUNCTION public.expire_media_preparations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_media_preparations(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=32 WHERE id=1 AND schema_version=31;
