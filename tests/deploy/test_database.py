"""Opt-in integration test against a disposable local Docker network/PostgreSQL17."""

import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import unittest
import uuid

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("deploy", REPO / "ops/deploy/deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


@unittest.skipUnless(
    os.environ.get("ECHO_MAX_TEST_IMAGE"),
    "set ECHO_MAX_TEST_IMAGE to a locally built application image",
)
class DatabaseTest(unittest.TestCase):
    def command(self, *args, data=None, check=True):
        result = subprocess.run(
            list(args), input=data, capture_output=True, timeout=180
        )
        if check and result.returncode:
            self.fail("isolated Docker operation failed: " + args[1])
        return result

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.network = "echo-max-deploy-test-" + uuid.uuid4().hex[:12]
        self.container = self.network + "-pg"
        self.passwords = {
            r: secrets.token_hex(24) for r in ("admin", "migrator", *deploy.ROLES)
        }
        deploy.atomic(
            self.directory / "postgres.env",
            "POSTGRES_USER=postgres\nPOSTGRES_DB=echo_max\nPOSTGRES_PASSWORD="
            + self.passwords["admin"]
            + "\n",
        )
        deploy.atomic(
            self.directory / "migrations.env",
            "DATABASE_URL_MIGRATIONS=postgres://echo_migrator:"
            + self.passwords["migrator"]
            + "@echo-max-postgres17:5432/echo_max\n",
        )
        deploy.atomic(self.directory / "passwords.json", json.dumps(self.passwords))
        self.command("docker", "network", "create", self.network)
        self.addCleanup(
            lambda: self.command("docker", "network", "rm", self.network, check=False)
        )
        self.addCleanup(
            lambda: self.command("docker", "rm", "-fv", self.container, check=False)
        )
        self.command(
            "docker",
            "run",
            "-d",
            "--name",
            self.container,
            "--network",
            self.network,
            "--network-alias",
            "echo-max-postgres17",
            "--env-file",
            str(self.directory / "postgres.env"),
            deploy.PG_IMAGE,
        )
        until = time.monotonic() + 45
        while time.monotonic() < until:
            if not self.command(
                "docker",
                "exec",
                self.container,
                "pg_isready",
                "-U",
                "postgres",
                "-d",
                "echo_max",
                check=False,
            ).returncode:
                break
            time.sleep(0.5)
        else:
            self.fail("isolated PostgreSQL17 readiness timeout")

    def sql(self, statement):
        result = self.command(
            "docker",
            "exec",
            "-i",
            self.container,
            "psql",
            "-U",
            "postgres",
            "-d",
            "echo_max",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            data=statement.encode(),
        )
        return result.stdout.decode().strip()

    def helper(self, mode, succeeds=True):
        result = self.command(
            "docker",
            "run",
            "--rm",
            "--network",
            self.network,
            "--user",
            "0",
            "--env-file",
            str(self.directory / "postgres.env"),
            "--env-file",
            str(self.directory / "migrations.env"),
            "--mount",
            f"type=bind,source={self.directory}/passwords.json,target=/run/passwords.json,readonly",
            "--mount",
            f"type=bind,source={REPO}/bootstrap/roles.sql,target=/run/roles.sql,readonly",
            "--mount",
            f"type=bind,source={REPO}/ops/deploy/database.mjs,target=/app/database.mjs,readonly",
            "--entrypoint",
            "node",
            os.environ["ECHO_MAX_TEST_IMAGE"],
            "/app/database.mjs",
            mode,
            check=False,
        )
        self.assertEqual(
            result.returncode == 0, succeeds, "database helper exit status"
        )
        for password in self.passwords.values():
            self.assertNotIn(password.encode(), result.stdout)
            self.assertNotIn(password.encode(), result.stderr)
        return json.loads(result.stdout) if succeeds else None

    def test_fresh_repeat_preserve_data_roles_migrations_and_guard_restore(self):
        expected = len(list((REPO / "migrations").glob("*.sql")))
        self.assertEqual(
            self.helper("prepare"),
            {"schemaVersion": expected, "fenced": True, "restored": False},
        )
        self.sql(
            "CREATE TABLE public.deployment_test_marker (value integer); INSERT INTO public.deployment_test_marker VALUES (42);"
        )
        password_hash = self.sql(
            "SELECT rolpassword FROM pg_authid WHERE rolname='echo_gateway';"
        )
        self.assertEqual(self.helper("prepare")["schemaVersion"], expected)
        self.assertTrue(
            password_hash
            == self.sql(
                "SELECT rolpassword FROM pg_authid WHERE rolname='echo_gateway';"
            )
        )
        self.assertEqual(
            self.sql("SELECT value FROM public.deployment_test_marker;"), "42"
        )
        self.assertEqual(
            self.sql("SELECT count(*) FROM public.schema_migrations;"), str(expected)
        )
        self.assertEqual(
            self.sql(
                "SELECT bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) FROM pg_roles WHERE rolname LIKE 'echo_%';"
            ),
            "t",
        )
        self.assertFalse(self.helper("open-first")["fenced"])
        self.assertFalse(self.helper("open-repeat")["fenced"])
        self.sql("UPDATE public.system_state SET restore_fence=true WHERE id=1;")
        self.helper("open-repeat", succeeds=False)
        self.assertEqual(
            self.sql("SELECT restore_fence FROM public.system_state;"), "t"
        )
        self.sql(
            "UPDATE public.system_state SET restored_snapshot_at=clock_timestamp(), deployment_epoch=1 WHERE id=1;"
        )
        self.assertTrue(self.helper("prepare")["restored"])
        self.helper("open-first", succeeds=False)
        self.sql(
            "UPDATE public.schema_migrations SET checksum=repeat('0',64) WHERE name=(SELECT min(name) FROM public.schema_migrations);"
        )
        self.helper("prepare", succeeds=False)
        self.assertEqual(
            self.sql("SELECT value FROM public.deployment_test_marker;"), "42"
        )


if __name__ == "__main__":
    unittest.main()
