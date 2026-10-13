-- Stage2 checkpoint40: isolated test storage only until privacy integration0025.
CREATE FUNCTION public.task_valid_timezone(value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT value IS NOT NULL AND EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=value)
$$;
CREATE FUNCTION public.task_valid_date(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL THEN RETURN true; END IF;
 RETURN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND value>='0001-01-01' AND value<='9999-12-31'
  AND to_char(value::date,'YYYY-MM-DD')=value;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.task_valid_instant(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL THEN RETURN true; END IF;
 RETURN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND value>='0001-01-01T00:00:00.000Z' AND value<='9999-12-31T23:59:59.999Z'
  AND to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=value;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.task_valid_title(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NOT NULL AND char_length(value) BETWEEN 1 AND 500 AND btrim(value)=value
 AND value!~'[[:cntrl:]]' AND strpos(value,chr(8232))=0 AND strpos(value,chr(8233))=0
$$;
CREATE FUNCTION public.task_valid_description(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NULL OR (char_length(value) BETWEEN 1 AND 10000 AND btrim(value)=value
 AND replace(replace(value,chr(10),''),chr(9),'')!~'[[:cntrl:]]')
$$;
CREATE TABLE public.work_items (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id), UNIQUE(id,user_id),
 title text NOT NULL CHECK(public.task_valid_title(title)), description text CHECK(public.task_valid_description(description)),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','completed','cancelled')),
 target_date date, scheduled_at timestamptz, due_date date, due_at timestamptz,
 timezone text NOT NULL CHECK(public.task_valid_timezone(timezone)), version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()), completed_at timestamptz, cancelled_at timestamptz,
 CHECK(target_date IS NULL OR (isfinite(target_date) AND target_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
 CHECK(due_date IS NULL OR (isfinite(due_date) AND due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
 CHECK(due_date IS NULL OR due_at IS NULL),
 CHECK(scheduled_at IS NULL OR due_at IS NULL OR scheduled_at<=due_at),
 CHECK(scheduled_at IS NULL OR due_date IS NULL OR (scheduled_at AT TIME ZONE timezone)::date<=due_date),
 CHECK((status='open' AND completed_at IS NULL AND cancelled_at IS NULL) OR
  (status='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL) OR
  (status='cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL))
);
CREATE FUNCTION public.valid_task_snapshot(s jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE key text; value text;
BEGIN
 IF jsonb_typeof(s)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>15 OR
 NOT s ?& ARRAY['id','userId','title','description','status','targetDate','scheduledAt','dueDate','dueAt','timezone','version','createdAt','updatedAt','completedAt','cancelledAt'] THEN RETURN false; END IF;
 IF jsonb_typeof(s->'version')<>'number' OR (s->>'version')::numeric<>trunc((s->>'version')::numeric) OR
 (s->>'version')::numeric NOT BETWEEN 1 AND 2147483647 THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['id','userId','title','status','timezone','createdAt','updatedAt'] LOOP
  IF jsonb_typeof(s->key)<>'string' THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['description','targetDate','scheduledAt','dueDate','dueAt','completedAt','cancelledAt'] LOOP
  IF jsonb_typeof(s->key) NOT IN ('null','string') THEN RETURN false; END IF;
 END LOOP;
 IF (s->>'id')::uuid='00000000-0000-0000-0000-000000000000'::uuid OR
 (s->>'userId')::uuid='00000000-0000-0000-0000-000000000000'::uuid OR
 NOT public.task_valid_title(s->>'title') OR NOT public.task_valid_description(s->>'description') OR
 NOT public.task_valid_timezone(s->>'timezone') OR NOT public.task_valid_date(s->>'targetDate') OR
 NOT public.task_valid_date(s->>'dueDate') THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['scheduledAt','dueAt','createdAt','updatedAt','completedAt','cancelledAt'] LOOP
  IF NOT public.task_valid_instant(s->>key) THEN RETURN false; END IF;
 END LOOP;
 IF s->>'dueDate' IS NOT NULL AND s->>'dueAt' IS NOT NULL THEN RETURN false; END IF;
 IF s->>'scheduledAt' IS NOT NULL AND s->>'dueAt' IS NOT NULL AND (s->>'scheduledAt')::timestamptz>(s->>'dueAt')::timestamptz THEN RETURN false; END IF;
 IF s->>'scheduledAt' IS NOT NULL AND s->>'dueDate' IS NOT NULL AND
 ((s->>'scheduledAt')::timestamptz AT TIME ZONE (s->>'timezone'))::date>(s->>'dueDate')::date THEN RETURN false; END IF;
 RETURN (s->>'status'='open' AND s->>'completedAt' IS NULL AND s->>'cancelledAt' IS NULL) OR
 (s->>'status'='completed' AND s->>'completedAt' IS NOT NULL AND s->>'cancelledAt' IS NULL) OR
 (s->>'status'='cancelled' AND s->>'cancelledAt' IS NOT NULL AND s->>'completedAt' IS NULL);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.task_row_snapshot(w public.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',w.id,'userId',w.user_id,'title',w.title,'description',w.description,'status',w.status,
 'targetDate',to_char(w.target_date,'YYYY-MM-DD'),'scheduledAt',to_char(w.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'dueDate',to_char(w.due_date,'YYYY-MM-DD'),'dueAt',to_char(w.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'timezone',w.timezone,'version',w.version,'createdAt',to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'completedAt',to_char(w.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'cancelledAt',to_char(w.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
CREATE FUNCTION public.check_task_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE stamp timestamptz;
BEGIN
 FOREACH stamp IN ARRAY ARRAY[NEW.scheduled_at,NEW.due_at,NEW.created_at,NEW.updated_at,NEW.completed_at,NEW.cancelled_at] LOOP
  IF stamp IS NOT NULL AND (NOT isfinite(stamp) OR stamp<'0001-01-01T00:00:00Z'::timestamptz OR
   stamp>'9999-12-31T23:59:59.999Z'::timestamptz OR stamp<>date_trunc('milliseconds',stamp)) THEN
   RAISE EXCEPTION 'Invalid task timestamp' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.created_at<>OLD.created_at) THEN
  RAISE EXCEPTION 'Task identity immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_row_validation BEFORE INSERT OR UPDATE ON public.work_items FOR EACH ROW EXECUTE FUNCTION public.check_task_row();
CREATE FUNCTION public.valid_task_receipt(r jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE entry jsonb; label text; identifier jsonb; idx integer:=0;
BEGIN
 IF jsonb_typeof(r)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>8 OR
 NOT r ?& ARRAY['receiptId','contractVersion','effectKey','outcome','commandResults','localIdMap','snapshots','error'] OR
 r->'contractVersion'<>'1'::jsonb OR jsonb_typeof(r->'receiptId')<>'string' OR
 jsonb_typeof(r->'outcome')<>'string' OR jsonb_typeof(r->'effectKey')<>'string' OR
 (r->>'receiptId')::uuid='00000000-0000-0000-0000-000000000000'::uuid OR
 r->>'effectKey'!~'^[A-Za-z0-9:_-]{1,200}$' OR r->>'outcome' NOT IN('applied','no_change','rejected') OR
 jsonb_typeof(r->'commandResults')<>'array' OR jsonb_typeof(r->'localIdMap')<>'object' OR jsonb_typeof(r->'snapshots')<>'array' THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(r->'snapshots') LOOP
  IF NOT public.valid_task_snapshot(entry) THEN RETURN false; END IF;
 END LOOP;
 FOR label,identifier IN SELECT key,value FROM jsonb_each(r->'localIdMap') LOOP
  IF label!~'^[A-Za-z0-9_-]{1,64}$' OR jsonb_typeof(identifier)<>'string' OR (identifier#>>'{}')::uuid='00000000-0000-0000-0000-000000000000'::uuid THEN RETURN false; END IF;
 END LOOP;
 IF r->>'outcome'='rejected' THEN RETURN COALESCE(r->'commandResults'='[]'::jsonb AND r->'snapshots'='[]'::jsonb AND r->'localIdMap'='{}'::jsonb
  AND jsonb_typeof(r->'error')='object' AND r->'error' ? 'code' AND jsonb_typeof(r->'error'->'code')='string'
  AND (SELECT count(*) FROM jsonb_object_keys(r->'error'))=CASE WHEN r->'error' ? 'index' THEN 2 ELSE 1 END
  AND r->'error'->>'code' IN('invalid_command','invalid_title','invalid_description','invalid_time','invalid_timezone',
  'ambiguous_local_time','nonexistent_local_time','invalid_schedule','invalid_evidence','unsupported_actor','task_not_found',
  'version_conflict','invalid_transition','idempotency_conflict','invalid_local_reference','group_limit_exceeded','version_exhausted','account_unavailable')
  AND (NOT r->'error' ? 'index' OR (jsonb_typeof(r->'error'->'index')='number' AND (r->'error'->>'index')::numeric BETWEEN 0 AND 19
  AND (r->'error'->>'index')::numeric=(r->'error'->>'index')::integer)),false); END IF;
 IF r->'error'<>'null'::jsonb OR jsonb_array_length(r->'commandResults') NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(r->'commandResults') LOOP
  IF jsonb_typeof(entry)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>6 OR
  NOT entry ?& ARRAY['index','kind','taskId','beforeVersion','afterVersion','outcome'] OR
  jsonb_typeof(entry->'index')<>'number' OR (entry->>'index')::integer NOT BETWEEN 0 AND 19 OR
  (entry->>'index')::numeric<>idx OR entry->>'kind' NOT IN('create','update','complete','cancel','reopen') OR
  jsonb_typeof(entry->'kind')<>'string' OR jsonb_typeof(entry->'outcome')<>'string' OR
  jsonb_typeof(entry->'taskId')<>'string' OR (entry->>'taskId')::uuid IS NULL OR
  jsonb_typeof(entry->'afterVersion')<>'number' OR (entry->>'afterVersion')::numeric NOT BETWEEN 1 AND 2147483647 OR
  (entry->>'afterVersion')::numeric<>(entry->>'afterVersion')::integer OR entry->>'outcome' NOT IN('applied','no_change') THEN RETURN false; END IF;
  IF entry->>'kind'='create' THEN
   IF entry->'beforeVersion'<>'null'::jsonb OR entry->'afterVersion'<>'1'::jsonb OR entry->>'outcome'<>'applied' THEN RETURN false; END IF;
  ELSE
   IF jsonb_typeof(entry->'beforeVersion')<>'number' OR (entry->>'beforeVersion')::numeric NOT BETWEEN 1 AND 2147483647 OR
    (entry->>'beforeVersion')::numeric<>(entry->>'beforeVersion')::integer OR
    (entry->>'afterVersion')::bigint<>(entry->>'beforeVersion')::bigint+(CASE WHEN entry->>'outcome'='applied' THEN 1 ELSE 0 END) THEN RETURN false; END IF;
  END IF;
  idx:=idx+1;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE public.task_command_receipts (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES public.users(id),UNIQUE(id,user_id),
 effect_key text NOT NULL CHECK(effect_key~'^[A-Za-z0-9:_-]{1,200}$'),UNIQUE(user_id,effect_key),
 contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version=1),payload_hash char(64) NOT NULL CHECK(payload_hash~'^[0-9a-f]{64}$'),
 canonical_payload jsonb NOT NULL CHECK(jsonb_typeof(canonical_payload)='object'),
 result jsonb NOT NULL CHECK((public.valid_task_receipt(result) AND result->>'receiptId'=id::text AND result->>'effectKey'=effect_key) IS TRUE),
 source_kind text NOT NULL CHECK(source_kind IN('typed','turn')),source_id uuid NOT NULL,actor text NOT NULL CHECK(actor IN('owner','operator','import')),
 source_occurred_at timestamptz NOT NULL CHECK(isfinite(source_occurred_at)),timezone_snapshot text NOT NULL CHECK(public.task_valid_timezone(timezone_snapshot)),
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp())
);
CREATE TABLE public.work_item_events (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES public.users(id),task_id uuid NOT NULL,receipt_id uuid NOT NULL,
 command_index integer NOT NULL CHECK(command_index BETWEEN 0 AND 19),effect_kind text NOT NULL CHECK(effect_kind IN('create','update','complete','cancel','reopen')),
 before_version integer,after_version integer NOT NULL CHECK(after_version>=1),before_state jsonb,after_state jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(task_id,user_id) REFERENCES public.work_items(id,user_id),FOREIGN KEY(receipt_id,user_id) REFERENCES public.task_command_receipts(id,user_id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(user_id,task_id,after_version),UNIQUE(user_id,receipt_id,command_index),
 CHECK((effect_kind='create' AND before_version IS NULL AND before_state IS NULL AND after_version=1) OR
  (effect_kind<>'create' AND before_version>=1 AND after_version::bigint=before_version::bigint+1 AND before_state IS NOT NULL)),
 CHECK(public.valid_task_snapshot(after_state) AND after_state->>'id'=task_id::text AND after_state->>'userId'=user_id::text AND (after_state->>'version')::integer=after_version),
 CHECK(before_state IS NULL OR (public.valid_task_snapshot(before_state) AND before_state->>'id'=task_id::text AND before_state->>'userId'=user_id::text AND (before_state->>'version')::integer=before_version))
);
CREATE FUNCTION public.reject_task_fact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='echo_migrator' AND current_setting('app.privacy_erasure',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Task facts immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON public.work_item_events FOR EACH ROW EXECUTE FUNCTION public.reject_task_fact_mutation();
CREATE TRIGGER task_receipts_immutable BEFORE UPDATE OR DELETE ON public.task_command_receipts FOR EACH ROW EXECUTE FUNCTION public.reject_task_fact_mutation();
CREATE FUNCTION public.check_task_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE task public.work_items%ROWTYPE; target uuid; tenant uuid; latest jsonb; versions bigint;
BEGIN
 target:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='work_items' THEN 'id' ELSE 'task_id' END)::uuid;tenant:=NEW.user_id;
 SELECT * INTO task FROM public.work_items WHERE id=target AND user_id=tenant;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT count(*) INTO versions FROM public.work_item_events WHERE task_id=target AND user_id=tenant;
 IF versions<>task.version THEN RAISE EXCEPTION 'Task history incomplete' USING ERRCODE='23514'; END IF;
 SELECT after_state INTO latest FROM public.work_item_events WHERE task_id=target AND user_id=tenant AND after_version=task.version;
 IF latest IS DISTINCT FROM public.task_row_snapshot(task) OR EXISTS(
 SELECT 1 FROM public.work_item_events e LEFT JOIN public.work_item_events p ON p.user_id=e.user_id AND p.task_id=e.task_id AND p.after_version=e.before_version
 WHERE e.user_id=tenant AND e.task_id=target AND e.after_version>1 AND e.before_state IS DISTINCT FROM p.after_state) THEN
 RAISE EXCEPTION 'Task state/history mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_history_current AFTER INSERT OR UPDATE ON public.work_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_task_history();
CREATE CONSTRAINT TRIGGER task_history_event AFTER INSERT ON public.work_item_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_task_history();
CREATE FUNCTION public.check_task_receipt_effects() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE receipt public.task_command_receipts%ROWTYPE; rid uuid; entry jsonb; amount integer;
BEGIN
 rid:=(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='task_command_receipts' THEN 'id' ELSE 'receipt_id' END)::uuid;
 SELECT * INTO receipt FROM public.task_command_receipts WHERE id=rid AND user_id=NEW.user_id;
 SELECT count(*) INTO amount FROM public.work_item_events WHERE receipt_id=rid AND user_id=NEW.user_id;
 IF receipt.result->>'outcome'='rejected' OR receipt.result->>'outcome'='no_change' THEN
  IF amount<>0 THEN RAISE EXCEPTION 'Receipt effects mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF amount=0 OR amount<>(SELECT count(*) FROM jsonb_array_elements(receipt.result->'commandResults') c WHERE c->>'outcome'='applied') THEN
   RAISE EXCEPTION 'Receipt effects incomplete' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.work_item_events e WHERE e.receipt_id=rid AND e.user_id=NEW.user_id AND
 NOT receipt.result->'commandResults' @> jsonb_build_array(jsonb_build_object('index',e.command_index,'kind',e.effect_kind,
 'taskId',e.task_id,'beforeVersion',e.before_version,'afterVersion',e.after_version,'outcome','applied'))) THEN
 RAISE EXCEPTION 'Receipt event mismatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.work_item_events e WHERE e.receipt_id=rid AND e.user_id=NEW.user_id AND
 NOT EXISTS(SELECT 1 FROM public.work_item_events later WHERE later.receipt_id=rid AND later.task_id=e.task_id AND later.after_version>e.after_version) AND
 NOT receipt.result->'snapshots' @> jsonb_build_array(e.after_state)) THEN
 RAISE EXCEPTION 'Receipt snapshot mismatch' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_receipt_consistency AFTER INSERT ON public.task_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_task_receipt_effects();
CREATE CONSTRAINT TRIGGER task_event_receipt_consistency AFTER INSERT ON public.work_item_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_task_receipt_effects();
CREATE INDEX tasks_status_created ON public.work_items(user_id,status,created_at DESC,id DESC);
CREATE INDEX tasks_target_open ON public.work_items(user_id,target_date,id) WHERE status='open';
CREATE INDEX tasks_schedule_open ON public.work_items(user_id,scheduled_at,id) WHERE status='open';
CREATE INDEX tasks_due_at_open ON public.work_items(user_id,due_at,id) WHERE status='open';
CREATE INDEX tasks_due_date_open ON public.work_items(user_id,due_date,id) WHERE status='open';
CREATE INDEX task_events_version ON public.work_item_events(user_id,task_id,after_version DESC);
CREATE INDEX task_events_recorded ON public.work_item_events(user_id,recorded_at DESC,id DESC);
DO $policies$ DECLARE tbl text;BEGIN
 FOREACH tbl IN ARRAY ARRAY['work_items','work_item_events','task_command_receipts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,echo_gateway,echo_worker,echo_delivery,echo_scheduler',tbl);
  EXECUTE format('CREATE POLICY task_tenant_read ON public.%I FOR SELECT TO echo_worker USING(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',tbl);
  EXECUTE format('CREATE POLICY task_tenant_insert ON public.%I FOR INSERT TO echo_worker WITH CHECK(user_id=NULLIF(current_setting(''app.user_id'',true),'''')::uuid)',tbl);
  EXECUTE format('CREATE POLICY task_migrator ON public.%I TO echo_migrator USING(true) WITH CHECK(true)',tbl);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO echo_worker',tbl);
 END LOOP;
END $policies$;
CREATE POLICY task_tenant_update ON public.work_items FOR UPDATE TO echo_worker USING(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(user_id=NULLIF(current_setting('app.user_id',true),'')::uuid);
GRANT UPDATE ON public.work_items TO echo_worker;
-- Functions used by invoker constraints/triggers need explicit runtime EXECUTE.
GRANT EXECUTE ON FUNCTION public.task_valid_timezone(text),public.task_valid_date(text),public.task_valid_instant(text),
 public.task_valid_title(text),public.task_valid_description(text),public.valid_task_snapshot(jsonb),public.task_row_snapshot(public.work_items),
 public.valid_task_receipt(jsonb) TO echo_worker;
UPDATE public.system_state SET schema_version=24 WHERE id=1 AND schema_version=23;
