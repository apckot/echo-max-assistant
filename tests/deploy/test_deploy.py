import importlib.util
import json
import os
import tempfile
import unittest
import subprocess
import time
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "deploy", Path(__file__).resolve().parents[2] / "ops/deploy/deploy.py"
)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.token = self.root / "secrets.txt"
        self.token.write_text("max-bot-token=private-test-token\n")
        self.token.chmod(0o600)
        self.config = self.root / "config.json"
        self.config.write_text(
            json.dumps(
                {
                    "domain": "твой-ассистент.рф",
                    "email": "owner@example.org",
                    "token_file": str(self.token),
                    "foundation_echo_enabled": True,
                }
            )
        )
        self.config.chmod(0o600)

    def installer(self):
        host = RecordingHost()
        installer = deploy.Installer(
            deploy.load_config(self.config),
            Path(__file__).resolve().parents[2],
            host,
            self.root,
        )
        os_release = installer.path("/etc/os-release")
        os_release.parent.mkdir(parents=True, exist_ok=True)
        os_release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        return installer, host

    def apply_fake(self, installer, subscriptions=None, helper=None):
        subscriptions = subscriptions or [
            {
                "url": installer.c["url"],
                "update_types": [
                    "message_created",
                    "message_callback",
                    "bot_started",
                    "bot_stopped",
                ],
            }
        ]
        from io import BytesIO

        with (
            patch.object(deploy.os, "geteuid", return_value=0),
            patch.object(deploy.platform, "system", return_value="Linux"),
            patch.object(deploy.shutil, "which", return_value="/usr/bin/tool"),
            patch.object(
                deploy.urllib.request,
                "urlopen",
                side_effect=lambda *a, **k: BytesIO(
                    b"-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----"
                ),
            ),
            patch.object(
                installer,
                "api",
                side_effect=lambda route: (
                    {"is_bot": True, "user_id": 1}
                    if route == "/me"
                    else {"subscriptions": subscriptions}
                ),
            ),
            patch.object(installer, "configure_nginx"),
            patch.object(
                installer,
                "helper",
                side_effect=helper
                or (
                    lambda mode: {
                        "schemaVersion": 23,
                        "fenced": not installer.state["completed"],
                        "restored": False,
                    }
                ),
            ),
            patch.object(
                installer,
                "health",
                return_value={
                    "schemaVersion": 23,
                    "ready": True,
                    "subscription": {"status": "healthy"},
                },
            ),
        ):
            installer.apply()

    def test_fresh_and_repeat_keep_credentials_data_and_never_publish_postgres(self):
        installer, host = self.installer()
        self.apply_fake(installer)
        first = deploy.private_json(installer.state_path)
        self.apply_fake(installer)
        self.assertEqual(first, deploy.private_json(installer.state_path))
        self.assertTrue(first["completed"])
        pg_runs = [a for a in host.calls if a[:3] == ["docker", "run", "-d"]]
        self.assertEqual(len(pg_runs), 1)
        self.assertNotIn("-p", pg_runs[0])
        self.assertFalse(any("rm" in a or "prune" in a for a in host.calls))
        self.assertNotIn("private-test-token", json.dumps(host.calls))
        self.assertIn(
            [
                "systemctl",
                "restart",
                *["echo-max-" + r + ".service" for r in deploy.ROLES],
            ],
            host.calls,
        )

    def test_foreign_webhook_refused_before_database_and_runtime_changes(self):
        installer, host = self.installer()
        with self.assertRaisesRegex(deploy.DeployError, "foreign_webhook_subscription"):
            self.apply_fake(installer, [{"url": "https://other.example/hook"}])
        self.assertFalse(installer.state_path.exists())
        self.assertFalse(any(a[:3] == ["docker", "run", "-d"] for a in host.calls))

    def test_manual_database_fence_is_not_reopened_on_repeat(self):
        installer, host = self.installer()
        self.apply_fake(installer)
        with self.assertRaisesRegex(deploy.DeployError, "restore_or_manual_fence"):
            self.apply_fake(
                installer,
                helper=lambda mode: {
                    "schemaVersion": 23,
                    "fenced": True,
                    "restored": False,
                },
            )

    def test_manual_runtime_fence_is_not_overwritten_on_repeat(self):
        installer, host = self.installer()
        self.apply_fake(installer)
        target = installer.env / "worker.env"
        target.write_text(target.read_text().replace("RESTORE_FENCE=off", "RESTORE_FENCE=on"))
        with self.assertRaisesRegex(deploy.DeployError, "runtime_fence_requires_operator"):
            self.apply_fake(installer)
        self.assertIn("RESTORE_FENCE=on", target.read_text())

    def test_activation_failure_fences_and_stops_only_installer_runtimes(self):
        installer, host = self.installer()
        host.fail_restart = True
        with self.assertRaises(deploy.DeployError):
            self.apply_fake(installer)
        installer.fence_on_failure()
        for role in deploy.ROLES:
            self.assertIn(
                "RESTORE_FENCE=on", (installer.env / (role + ".env")).read_text()
            )
        self.assertEqual(
            host.calls[-1],
            [
                "systemctl",
                "stop",
                *["echo-max-" + r + ".service" for r in deploy.ROLES],
            ],
        )
        self.assertFalse(deploy.private_json(installer.state_path)["completed"])

    def test_nginx_failure_rolls_back_and_repeat_keeps_tls_listener(self):
        installer, host = self.installer()
        site = installer.path("/etc/nginx/conf.d/echo-max.conf")
        old = deploy.MANAGED + "server { listen 443 ssl; }\n"
        deploy.managed_write(site, old)
        host.on_certbot = lambda: self.assertEqual(site.read_text(), old)
        host.fail_certbot = True
        with patch.object(installer, "verify_public_dns"), self.assertRaises(
            deploy.DeployError
        ):
            installer.configure_nginx()
        self.assertEqual(site.read_text(), old)
        site.unlink()
        host.fail_certbot = False
        host.fail_nginx = True
        with self.assertRaises(deploy.DeployError):
            installer.configure_nginx()
        self.assertFalse(site.exists())

    def test_named_token_is_value_only_and_raw_value_supported(self):
        c = deploy.load_config(self.config)
        self.assertEqual(c["token"], "private-test-token")
        self.assertEqual(c["domain"], "xn----8sbeood6ac4aabdjc.xn--p1ai")
        self.token.write_text("another-private-token\n")
        self.assertEqual(
            deploy.load_config(self.config)["token"], "another-private-token"
        )

    def test_world_readable_secrets_and_invalid_configuration_rejected(self):
        self.token.chmod(0o644)
        with self.assertRaises(deploy.DeployError):
            deploy.load_config(self.config)
        self.token.chmod(0o600)
        c = json.loads(self.config.read_text())
        c["gateway_port"] = 443
        self.config.write_text(json.dumps(c))
        with self.assertRaises(deploy.DeployError):
            deploy.load_config(self.config)

    def test_generated_credentials_survive_repeat_and_configuration_conflict_refused(
        self,
    ):
        c = deploy.load_config(self.config)
        first = deploy.state_for(self.root / "state.json", c, "a" * 40, "test-bot")
        second = deploy.state_for(self.root / "state.json", c, "a" * 40, "test-bot")
        self.assertEqual(first, second)
        self.assertEqual((self.root / "state.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(deploy.DeployError):
            deploy.state_for(self.root / "state.json", c, "b" * 40, "test-bot")
        with self.assertRaises(deploy.DeployError):
            deploy.state_for(self.root / "state.json", c, "a" * 40, "different-bot")

    def test_plan_does_not_include_token_or_change_target(self):
        c = deploy.load_config(self.config)
        plan = deploy.plan(c)
        self.assertNotIn("private-test-token", json.dumps(plan))
        self.assertFalse((self.root / "state.json").exists())
        self.assertIn("webhook", plan["steps"])

    def test_private_env_is_role_specific_and_includes_max_ca(self):
        c = deploy.load_config(self.config)
        state = deploy.state_for(self.root / "state.json", c, "a" * 40, "test-bot")
        deploy.write_envs(self.root / "env", c, state)
        text = (self.root / "env/gateway.env").read_text()
        self.assertIn("MAX_BOT_TOKEN=private-test-token\n", text)
        self.assertNotIn("max-bot-token=", text)
        self.assertIn("DATABASE_URL_GATEWAY=", text)
        self.assertNotIn("DATABASE_URL_MIGRATIONS=", text)
        self.assertNotIn("DATABASE_URL_WORKER=", text)
        self.assertIn("NODE_EXTRA_CA_CERTS=/run/echo-max-ca.pem", text)
        self.assertIn("RESTORE_FENCE=on", text)

    def test_unknown_file_cannot_be_overwritten_and_unit_reuses_existing_artifact(self):
        target = self.root / "site"
        target.write_text("existing-other-service")
        with self.assertRaises(deploy.DeployError):
            deploy.managed_write(target, "# Managed by Echo MAX\nnew")
        self.assertEqual(target.read_text(), "existing-other-service")
        repo = Path(__file__).resolve().parents[2]
        unit = deploy.runtime_unit(repo, "gateway", "echo-max:abc", 18080)
        self.assertIn("127.0.0.1:18080:8080", unit)
        self.assertIn("USER", (repo / "deploy/Dockerfile").read_text())
        self.assertIn("--read-only", unit)
        self.assertIn("--memory 128m", unit)
        self.assertNotIn("private-test-token", unit)


class RecordingHost:
    def __init__(self):
        self.calls = []
        self.objects = {}
        self.fail_restart = False
        self.fail_certbot = False
        self.fail_nginx = False
        self.on_certbot = lambda: None

    def run(self, args, data=None, allow_failure=False):
        self.calls.append(args)
        out = b""
        code = 0
        if args[0] == "git":
            if "rev-parse" in args:
                out = ("a" * 40).encode()
            if "archive" in args:
                out = b"archive"
        if args[0] == "docker":
            if "inspect" in args:
                obj = self.objects.get(args[-1])
                code = 0 if obj else 1
                if obj:
                    out = json.dumps([obj]).encode()
            elif args[1] in ("network", "volume") and args[2] == "create":
                self.objects[args[-1]] = {"Labels": {deploy.LABEL: "true"}}
            elif args[1:3] == ["run", "-d"]:
                self.objects["echo-max-postgres17"] = {
                    "Config": {"Labels": {deploy.LABEL: "true"}}
                }
        if args[0] == "certbot":
            self.on_certbot()
            code = int(self.fail_certbot)
        if args == ["nginx", "-t"]:
            code = int(self.fail_nginx)
        if args[:2] == ["systemctl", "restart"]:
            code = int(self.fail_restart)
        if code and not allow_failure:
            raise deploy.DeployError("test_command_failed")
        return SimpleNamespace(stdout=out, returncode=code)


if __name__ == "__main__":
    unittest.main()
