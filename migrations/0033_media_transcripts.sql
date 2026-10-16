ALTER TABLE public.media_preparations ADD COLUMN wire_count integer NOT NULL DEFAULT 0 CHECK(wire_count BETWEEN 0 AND 1);
ALTER TABLE public.media_preparations ADD COLUMN stt_duration_ms numeric CHECK(stt_duration_ms>=0);
ALTER TABLE public.media_preparations ADD COLUMN usage jsonb;
ALTER TABLE public.media_preparations ADD CONSTRAINT media_checksum_unique UNIQUE(user_id,turn_id,checksum);
GRANT UPDATE(wire_count,stt_duration_ms,usage) ON public.media_preparations TO echo_worker;
CREATE FUNCTION public.valid_media_transcript(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(value)='object' AND value-ARRAY['version','text','language','confidence','segments','criticalUncertainty','audioChecksum','provider','model','profileVersion']='{}'::jsonb
 AND value->'version'='1'::jsonb AND jsonb_typeof(value->'text')='string' AND length(value->>'text') BETWEEN 1 AND 32000 AND octet_length(value->>'text')<=128000
 AND value->>'audioChecksum'~'^[a-f0-9]{64}$' AND jsonb_typeof(value->'segments')='array'
 AND (value->'criticalUncertainty'='null'::jsonb OR jsonb_typeof(value->'criticalUncertainty')='array')
 AND (value->'confidence'='null'::jsonb OR jsonb_typeof(value->'confidence')='number')
 AND (value->'language'='null'::jsonb OR jsonb_typeof(value->'language')='string')
 AND jsonb_typeof(value->'provider')='string' AND jsonb_typeof(value->'model')='string' AND jsonb_typeof(value->'profileVersion')='number',false)
$$;
REVOKE ALL ON FUNCTION public.valid_media_transcript(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_media_transcript(jsonb) TO echo_worker;
CREATE TABLE public.media_transcripts(
 user_id uuid NOT NULL,turn_id uuid NOT NULL,fact jsonb NOT NULL CHECK(public.valid_media_transcript(fact) IS TRUE),
 audio_checksum text GENERATED ALWAYS AS(fact->>'audioChecksum') STORED,
 text text GENERATED ALWAYS AS(fact->>'text') STORED,
 text_digest text GENERATED ALWAYS AS(encode(digest(fact->>'text','sha256'),'hex')) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,turn_id),
 FOREIGN KEY(user_id,turn_id,audio_checksum) REFERENCES public.media_preparations(user_id,turn_id,checksum) ON DELETE CASCADE
);
ALTER TABLE public.media_transcripts ENABLE ROW LEVEL SECURITY;ALTER TABLE public.media_transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY transcripts_tenant ON public.media_transcripts TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY transcripts_migrator ON public.media_transcripts TO echo_migrator USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.media_transcripts TO echo_worker;
ALTER FUNCTION public.account_erasure_counts(uuid) RENAME TO account_erasure_counts_v32;
CREATE FUNCTION public.account_erasure_counts(target uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.account_erasure_counts_v32(target)||jsonb_build_object('mediaTranscripts',(SELECT count(*) FROM public.media_transcripts WHERE user_id=target))
$$;
REVOKE ALL ON FUNCTION public.account_erasure_counts(uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.delivered_history(conv uuid,source_at timestamptz) RETURNS TABLE(user_text text,assistant_text text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(d.plan->'context'->'source'->>'text',nullif(c.snapshot->'source'->>'text','')),o.payload->>'text'
 FROM public.agent_turn_content c LEFT JOIN public.accepted_decisions d USING(user_id,turn_id)
 JOIN public.outbound_messages o ON o.source_inbound_event_id=c.source_event_id AND o.user_id=c.user_id
 WHERE c.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND o.conversation_id=conv
 AND o.created_at>=source_at-interval '48 hours' AND o.created_at<=source_at
 AND EXISTS(SELECT 1 FROM public.delivery_attempts a WHERE a.outbound_message_id=o.id AND a.user_id=o.user_id AND a.phase='completed' AND a.certainty='sent')
 AND coalesce(d.plan->'context'->'source'->>'text',nullif(c.snapshot->'source'->>'text','')) IS NOT NULL
 ORDER BY o.created_at DESC,o.id DESC LIMIT 12
$$;
CREATE FUNCTION public.cleanup_media_metadata(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n integer;BEGIN
 IF batch IS NULL OR batch<1 OR batch>100 THEN RAISE EXCEPTION 'Invalid cleanup batch';END IF;
 PERFORM 1 FROM public.system_state WHERE id=1 AND NOT restore_fence FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup fenced';END IF;
 WITH due AS(SELECT user_id,turn_id FROM public.media_preparations WHERE phase IN('transcribed','failed') AND NOT bytes_released ORDER BY created_at LIMIT batch FOR UPDATE SKIP LOCKED)
 UPDATE public.media_preparations m SET bytes_released=true FROM due d WHERE m.user_id=d.user_id AND m.turn_id=d.turn_id;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;END $$;
REVOKE ALL ON FUNCTION public.cleanup_media_metadata(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_media_metadata(integer) TO echo_scheduler;
UPDATE public.system_state SET schema_version=33 WHERE id=1 AND schema_version=32;
