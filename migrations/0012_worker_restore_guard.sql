-- Narrow worker admission capability; application roles still cannot read state.
CREATE FUNCTION public.guard_worker_restore_fence() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $guard$
DECLARE
  fenced boolean;
BEGIN
  SELECT s.restore_fence INTO fenced FROM public.system_state AS s WHERE s.id = 1 FOR SHARE;
  IF NOT FOUND OR fenced THEN
    RAISE EXCEPTION 'Worker unavailable' USING ERRCODE = 'P0001';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_worker_restore_fence()
  FROM PUBLIC, echo_gateway, echo_delivery, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.guard_worker_restore_fence() TO echo_worker;
UPDATE public.system_state SET schema_version = 12 WHERE id = 1 AND schema_version = 11;
