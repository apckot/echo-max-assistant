-- Cancellation survives reactivation and late materialization of old sources.
-- The lifecycle owner already locks/updates these conversation rows; no outbox
-- scan is added to ingress. Physical cancellation is finalized on claim/admit.
ALTER TABLE public.conversations ADD COLUMN delivery_cancelled_through_sequence bigint
  NOT NULL DEFAULT 0 CHECK (delivery_cancelled_through_sequence >= 0);

-- Account-wide historical stops did not record sibling sequence cutoffs. An
-- active multi-conversation history requires reconciliation, not guessed loss.
DO $history$
BEGIN
  IF EXISTS (SELECT 1 FROM public.channel_accounts a
    WHERE (SELECT count(*) FROM public.conversations c WHERE c.channel_account_id=a.id)>1
      AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.channel_account_id=a.id AND c.state='active')
      AND EXISTS (SELECT 1 FROM public.inbound_events e JOIN public.conversations c ON c.id=e.conversation_id
        WHERE c.channel_account_id=a.id AND e.kind='lifecycle' AND e.payload->>'lifecycleType'='stopped')) THEN
    RAISE EXCEPTION 'Ambiguous historical delivery cancellation' USING ERRCODE='P0001';
  END IF;
END;
$history$;

-- Upgrade existing history, including conversations that have restarted since
-- their latest stop. This one-time migration scan is outside gateway ingress.
UPDATE public.conversations c SET delivery_cancelled_through_sequence = GREATEST(
  CASE WHEN c.state='stopped' THEN c.next_inbound_sequence-1 ELSE 0 END,
  COALESCE((SELECT max(e.sequence-1) FROM public.inbound_events e
    WHERE e.conversation_id=c.id AND e.user_id=c.user_id AND e.kind='lifecycle'
      AND e.payload->>'lifecycleType'='stopped'), 0));

CREATE FUNCTION public.advance_delivery_stop_cutoff() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $cutoff$
BEGIN
  IF NEW.state='stopped' THEN
    NEW.delivery_cancelled_through_sequence := GREATEST(
      OLD.delivery_cancelled_through_sequence, OLD.next_inbound_sequence-1);
  END IF;
  RETURN NEW;
END;
$cutoff$;
REVOKE ALL ON FUNCTION public.advance_delivery_stop_cutoff()
  FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
CREATE TRIGGER delivery_stop_cutoff BEFORE UPDATE OF state ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.advance_delivery_stop_cutoff();
GRANT SELECT (delivery_cancelled_through_sequence) ON public.conversations TO echo_delivery;

UPDATE public.system_state SET schema_version=16 WHERE id=1 AND schema_version=15;
