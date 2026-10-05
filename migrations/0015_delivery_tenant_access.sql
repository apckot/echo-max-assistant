-- Delivery discovers tenant relationships, then locks identity rows before work.
-- Row locks require an UPDATE privilege; only the harmless timestamp is granted.
CREATE POLICY identity_delivery_select ON public.users FOR SELECT TO echo_delivery
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_delivery_update ON public.users FOR UPDATE TO echo_delivery
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_delivery_select ON public.channel_accounts FOR SELECT TO echo_delivery
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_delivery_update ON public.channel_accounts FOR UPDATE TO echo_delivery
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_delivery_select ON public.conversations FOR SELECT TO echo_delivery
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_delivery_update ON public.conversations FOR UPDATE TO echo_delivery
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY inbound_events_delivery_select ON public.inbound_events FOR SELECT TO echo_delivery
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT (id, status), UPDATE (updated_at) ON public.users TO echo_delivery;
GRANT SELECT (id, user_id, state, external_user_id), UPDATE (updated_at)
  ON public.channel_accounts TO echo_delivery;
GRANT SELECT (id, user_id, channel_account_id, state), UPDATE (updated_at)
  ON public.conversations TO echo_delivery;
GRANT SELECT (id, user_id, conversation_id, sequence) ON public.inbound_events TO echo_delivery;

UPDATE public.system_state SET schema_version = 15 WHERE id = 1 AND schema_version = 14;
