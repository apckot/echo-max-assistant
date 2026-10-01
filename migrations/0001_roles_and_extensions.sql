-- All routine migrations run as echo_migrator, never as an application role.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO echo_gateway, echo_worker, echo_delivery, echo_scheduler;
ALTER DEFAULT PRIVILEGES FOR ROLE echo_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
