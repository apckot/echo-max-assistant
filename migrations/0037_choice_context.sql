CREATE INDEX choice_conversation_context ON public.pending_choices(user_id,conversation_id,created_at DESC);
CREATE FUNCTION public.choice_context(conv uuid,message_id text) RETURNS TABLE(id uuid,revision integer,topic text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.id,c.revision,left(coalesce((SELECT string_agg(o.label,' / ' ORDER BY o.ordinal) FROM public.pending_choice_options o WHERE o.user_id=c.user_id AND o.choice_id=c.id AND o.ordinal>0),'Сохранённый выбор'),360)
 FROM public.pending_choices c WHERE c.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND c.conversation_id=conv
 AND (message_id IS NOT NULL OR c.state='pending' AND c.expires_at>clock_timestamp())
 AND EXISTS(SELECT 1 FROM public.delivery_attempts d WHERE d.user_id=c.user_id AND d.outbound_message_id=c.outbound_id AND d.phase='completed' AND d.certainty='sent' AND (message_id IS NULL OR d.external_message_id=message_id) AND public.verified_choice_delivery(c.id,d.external_message_id,conv))
 ORDER BY c.created_at DESC,c.id DESC LIMIT CASE WHEN message_id IS NULL THEN 3 ELSE 10 END
$$;
REVOKE ALL ON FUNCTION public.choice_context(uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.choice_context(uuid,text) TO echo_worker;
UPDATE public.system_state SET schema_version=37 WHERE id=1 AND schema_version=36;

ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_choice_conversation_unique UNIQUE(id,user_id,conversation_id);
ALTER TABLE public.pending_choices ADD CONSTRAINT choice_conversation_unique UNIQUE(id,user_id,conversation_id);
ALTER TABLE public.pending_choices ADD CONSTRAINT choice_outbound_conversation_fk FOREIGN KEY(outbound_id,user_id,conversation_id) REFERENCES public.outbound_messages(id,user_id,conversation_id) ON DELETE CASCADE;
ALTER TABLE public.outbound_messages ADD CONSTRAINT choice_result_conversation_fk FOREIGN KEY(choice_id,user_id,conversation_id) REFERENCES public.pending_choices(id,user_id,conversation_id) ON DELETE CASCADE;

ALTER TABLE public.pending_choices ADD CONSTRAINT choice_origin_conversation_fk FOREIGN KEY(turn_id,user_id,conversation_id) REFERENCES public.agent_runs(turn_id,user_id,conversation_id) ON DELETE CASCADE;
