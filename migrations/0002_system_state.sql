-- Operational metadata is owned and maintained by echo_migrator only.
CREATE TABLE public.system_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  restore_fence boolean NOT NULL DEFAULT false,
  restored_snapshot_at timestamptz,
  deployment_epoch bigint NOT NULL DEFAULT 0 CHECK (deployment_epoch >= 0)
);

INSERT INTO public.system_state (id, schema_version) VALUES (1, 2);

REVOKE ALL ON public.system_state FROM PUBLIC, echo_gateway, echo_worker, echo_delivery, echo_scheduler;
