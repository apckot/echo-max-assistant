-- Guard before queue/tenant locks, in the same transaction; never across MAX I/O.
-- FOR SHARE serializes fence activation with already admitted delivery work.
CREATE FUNCTION public.guard_delivery_restore_fence() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $guard$
DECLARE
  fenced boolean;
BEGIN
  SELECT s.restore_fence INTO fenced FROM public.system_state AS s WHERE s.id = 1 FOR SHARE;
  IF NOT FOUND OR fenced THEN
    RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE = 'P0001';
  END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_delivery_restore_fence()
  FROM PUBLIC, echo_gateway, echo_worker, echo_scheduler;
GRANT EXECUTE ON FUNCTION public.guard_delivery_restore_fence() TO echo_delivery;
UPDATE public.system_state SET schema_version = 17 WHERE id = 1 AND schema_version = 16;
