-- Runtime identity reads and updates require a transaction-local tenant UUID.
-- NULLIF also closes the empty-string case left by a reset custom setting.
CREATE POLICY identity_worker_select ON public.users
  FOR SELECT TO echo_worker
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_worker_update ON public.users
  FOR UPDATE TO echo_worker
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY identity_worker_select ON public.channel_accounts
  FOR SELECT TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_worker_update ON public.channel_accounts
  FOR UPDATE TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY identity_worker_select ON public.conversations
  FOR SELECT TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY identity_worker_update ON public.conversations
  FOR UPDATE TO echo_worker
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, UPDATE ON public.users, public.channel_accounts, public.conversations TO echo_worker;

UPDATE public.system_state SET schema_version = 5 WHERE id = 1 AND schema_version = 4;
