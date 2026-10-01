-- The function owner is subject to FORCE RLS; only the closed migrator role
-- can use these policies. Application roles keep no table privileges.
CREATE POLICY identity_migrator ON public.users
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY identity_migrator ON public.channel_accounts
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);
CREATE POLICY identity_migrator ON public.conversations
  FOR ALL TO echo_migrator USING (true) WITH CHECK (true);

CREATE FUNCTION public.resolve_or_create_max_identity(
  external_user_id text,
  external_conversation_id text,
  event_type text
)
RETURNS TABLE (user_id uuid, channel_account_id uuid, conversation_id uuid, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve$
DECLARE
  account_row public.channel_accounts%ROWTYPE;
  conversation_row public.conversations%ROWTYPE;
  existing_user_status text;
  new_user_id uuid;
BEGIN
  -- MAX IDs are canonical signed int64 decimals. Keep them as text
  -- so JavaScript never rounds an external 64-bit identifier.
  IF external_user_id IS NULL OR external_conversation_id IS NULL
    OR external_user_id !~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$'
    OR external_conversation_id !~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$'
    OR event_type IS NULL
    OR event_type NOT IN ('bot_started', 'bot_stopped', 'message_created', 'message_callback') THEN
    RAISE EXCEPTION 'Invalid MAX identity input' USING ERRCODE = '22023';
  END IF;
  IF external_user_id::numeric NOT BETWEEN -9223372036854775808 AND 9223372036854775807
    OR external_conversation_id::numeric NOT BETWEEN -9223372036854775808 AND 9223372036854775807 THEN
    RAISE EXCEPTION 'Invalid MAX identity input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('max:user:' || external_user_id, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('max:chat:' || external_conversation_id, 0));

  SELECT a.* INTO account_row FROM public.channel_accounts AS a
    WHERE a.provider = 'max' AND a.external_user_id = $1;
  IF FOUND THEN
    SELECT u.status INTO existing_user_status FROM public.users AS u WHERE u.id = account_row.user_id;
    IF existing_user_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'MAX identity unavailable' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT c.* INTO conversation_row FROM public.conversations AS c
    WHERE c.provider = 'max' AND c.external_conversation_id = $2;
  IF FOUND AND (account_row.id IS NULL OR conversation_row.channel_account_id <> account_row.id) THEN
    RAISE EXCEPTION 'MAX identity unavailable' USING ERRCODE = 'P0001';
  END IF;

  IF account_row.id IS NULL THEN
    INSERT INTO public.users DEFAULT VALUES RETURNING id INTO new_user_id;
    INSERT INTO public.channel_accounts (user_id, external_user_id)
      VALUES (new_user_id, external_user_id) RETURNING * INTO account_row;
  END IF;

  IF conversation_row.id IS NULL THEN
    INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id, state)
      VALUES (account_row.user_id, account_row.id, external_conversation_id, account_row.state)
      RETURNING * INTO conversation_row;
  END IF;

  IF event_type = 'bot_stopped' THEN
    UPDATE public.channel_accounts AS a SET state = 'stopped', updated_at = now()
      WHERE a.id = account_row.id;
    UPDATE public.conversations AS c SET state = 'stopped', updated_at = now()
      WHERE c.channel_account_id = account_row.id;
    conversation_row.state := 'stopped';
  ELSIF event_type = 'bot_started' THEN
    UPDATE public.channel_accounts AS a SET state = 'active', updated_at = now()
      WHERE a.id = account_row.id;
    UPDATE public.conversations AS c SET state = 'active', updated_at = now()
      WHERE c.channel_account_id = account_row.id;
    conversation_row.state := 'active';
  END IF;

  RETURN QUERY SELECT account_row.user_id, account_row.id, conversation_row.id, conversation_row.state;
END;
$resolve$;

REVOKE ALL ON FUNCTION public.resolve_or_create_max_identity(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_or_create_max_identity(text, text, text) FROM echo_migrator;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_max_identity(text, text, text) TO echo_gateway;

UPDATE public.system_state SET schema_version = 4 WHERE id = 1 AND schema_version = 3;
