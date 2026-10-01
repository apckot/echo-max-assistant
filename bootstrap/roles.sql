-- Run once as the database owner or a DBA against an isolated application database.
-- Passwords are deliberately absent; provision distinct secrets before runtime use.
CREATE ROLE echo_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE echo_gateway LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE echo_worker LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE echo_delivery LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE echo_scheduler LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $bootstrap$ BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO echo_migrator', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO echo_gateway, echo_worker, echo_delivery, echo_scheduler', current_database());
END $bootstrap$;
