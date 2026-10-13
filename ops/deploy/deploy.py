#!/usr/bin/env python3
"""Run on the target Ubuntu host. No SSH, secret logging, or destructive reset."""

import argparse
import fcntl
import json
import os
import platform
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

MANAGED = "# Managed by Echo MAX\n"
LABEL = "org.echo-max.installer"
ROLES = ("gateway", "worker", "delivery", "scheduler")
PG_IMAGE = "postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826"


class DeployError(Exception):
    pass


def private_json(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise DeployError("private_file_required")
    return json.loads(path.read_text())


def load_config(path):
    c = private_json(Path(path))
    c["domain"] = c["domain"].encode("idna").decode("ascii").lower()
    if (
        len(c["domain"]) > 253
        or "." not in c["domain"]
        or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in c["domain"].split(".")
        )
    ):
        raise DeployError("invalid_domain")
    if not re.fullmatch(r"[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+", c["email"]):
        raise DeployError("invalid_email")
    c["gateway_port"] = c.get("gateway_port", 18080)
    if type(c["gateway_port"]) is not int or not 1024 <= c["gateway_port"] <= 65535:
        raise DeployError("invalid_gateway_port")
    if c.get("foundation_echo_enabled") is not True:
        raise DeployError("explicit_foundation_opt_in_required")
    token_file = Path(c["token_file"])
    if (
        not token_file.is_absolute()
        or not token_file.is_file()
        or token_file.is_symlink()
        or token_file.stat().st_mode & 0o077
    ):
        raise DeployError("private_token_file_required")
    token = token_file.read_text().strip()
    for prefix in ("max-bot-token=", "MAX_BOT_TOKEN="):
        if token.startswith(prefix):
            token = token[len(prefix) :].strip()
            break
    if not re.fullmatch(r"[A-Za-z0-9_.:/+=-]{1,4096}", token):
        raise DeployError("invalid_token_value")
    c["token"] = token
    c["url"] = "https://" + c["domain"] + "/webhooks/max"
    return c


def atomic(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def managed_write(path, text):
    if path.is_symlink() or (
        path.exists() and MANAGED.strip() not in path.read_text().splitlines()[:2]
    ):
        raise DeployError("unmanaged_file_conflict")
    if not path.exists() or path.read_text() != text:
        atomic(path, text, 0o644)


def state_for(path, c, revision, bot):
    identity = {
        "revision": revision,
        "domain": c["domain"],
        "port": c["gateway_port"],
        "bot": str(bot),
    }
    if path.exists():
        s = private_json(path)
        if s["identity"] != identity:
            raise DeployError("existing_installation_identity_conflict")
        return s
    s = {
        "identity": identity,
        "passwords": {r: secrets.token_hex(24) for r in ("admin", "migrator", *ROLES)},
        "webhook_secret": secrets.token_hex(32),
        "ops_token": secrets.token_hex(32),
        "completed": False,
    }
    atomic(path, json.dumps(s))
    return s


def write_envs(directory, c, s):
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    common = {
        "NODE_ENV": "production",
        "MAX_BOT_TOKEN": c["token"],
        "MAX_WEBHOOK_SECRET": s["webhook_secret"],
        "MAX_WEBHOOK_SECRET_VERSION": "v1",
        "MAX_WEBHOOK_URL": c["url"],
        "RESTORE_FENCE": "on",
        "FOUNDATION_ECHO_ENABLED": "true",
        "NODE_EXTRA_CA_CERTS": "/run/echo-max-ca.pem",
    }

    def env(name, values):
        atomic(
            directory / name,
            "".join(k + "=" + str(v) + "\n" for k, v in values.items()),
        )

    for r in ROLES:
        values = {
            **common,
            "DATABASE_URL_"
            + r.upper(): f'postgres://echo_{r}:{s["passwords"][r]}@echo-max-postgres17:5432/echo_max',
        }
        if r == "gateway":
            values.update(OPS_HEALTH_TOKEN=s["ops_token"], GATEWAY_DB_POOL_SIZE=3)
        if r == "worker":
            values["WORKER_CONCURRENCY"] = 1
        if r == "delivery":
            values["DELIVERY_CONCURRENCY"] = 1
        env(r + ".env", values)
    env(
        "postgres.env",
        {
            "POSTGRES_USER": "postgres",
            "POSTGRES_DB": "echo_max",
            "POSTGRES_PASSWORD": s["passwords"]["admin"],
        },
    )
    env(
        "migrations.env",
        {
            "DATABASE_URL_MIGRATIONS": f'postgres://echo_migrator:{s["passwords"]["migrator"]}@echo-max-postgres17:5432/echo_max'
        },
    )
    atomic(directory / "passwords.json", json.dumps(s["passwords"]))


def runtime_unit(repo, role, image, port):
    text = (repo / f"deploy/systemd/echo-max-{role}.service").read_text()
    text = text.replace("echo-max:stage1", image).replace(
        "127.0.0.1:8080:8080", f"127.0.0.1:{port}:8080"
    )
    text = text.replace(
        "docker run --rm",
        "docker run --rm --memory 128m --memory-swap 192m --label " + LABEL + "=true",
    )
    text = text.replace(
        "--env-file",
        "--mount type=bind,source=/etc/echo-max/certs/max-ca.pem,target=/run/echo-max-ca.pem,readonly --env-file",
    )
    return MANAGED + text


def plan(c):
    return {
        "domain": c["domain"],
        "gateway_bind": "127.0.0.1:" + str(c["gateway_port"]),
        "steps": [
            "preflight",
            "dependencies",
            "MAX_CA_and_auth",
            "image",
            "PostgreSQL17",
            "roles_and_migrations",
            "nginx_TLS",
            "four_runtimes",
            "health",
            "webhook",
        ],
        "database_reset": False,
    }


class Host:
    def run(self, args, data=None, allow_failure=False):
        r = subprocess.run(
            args,
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
        )
        if r.returncode and not allow_failure:
            raise DeployError("command_failed_" + Path(args[0]).name)
        return r


class Installer:
    def __init__(self, c, repo, host=None, root=Path("/")):
        self.c, self.repo, self.host, self.root = c, repo, host or Host(), root
        self.env = self.path("/etc/echo-max")
        self.state_path = self.env / "install-state.json"
        self.phase = "preflight"
        self.owned_runtime = False

    def path(self, value):
        return self.root / value.lstrip("/")

    def command(self, *args, **kwargs):
        return self.host.run(list(args), **kwargs)

    def event(self, phase):
        self.phase = phase
        print(json.dumps({"deploy": phase}), flush=True)

    def wait(self, probe, seconds=60):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            try:
                value = probe()
                if value:
                    return value
            except Exception:
                pass
            time.sleep(0.5)
        raise DeployError("readiness_timeout")

    def docker_object(self, kind, name):
        args = (
            ["docker", "inspect", name]
            if kind == "container"
            else ["docker", kind, "inspect", name]
        )
        r = self.host.run(args, allow_failure=True)
        if r.returncode:
            return None
        obj = json.loads(r.stdout)[0]
        labels = (
            obj.get("Labels") if kind != "container" else obj["Config"].get("Labels")
        )
        if (labels or {}).get(LABEL) != "true":
            raise DeployError("unmanaged_docker_resource_conflict")
        return obj

    def api(self, route):
        context = ssl.create_default_context()
        context.load_verify_locations(str(self.env / "certs/max-ca.pem"))

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context),
            NoRedirect(),
        )
        req = urllib.request.Request(
            "https://platform-api2.max.ru" + route,
            headers={"Authorization": self.c["token"]},
        )
        try:
            with opener.open(req, timeout=10) as r:
                raw = r.read(65537)
                if len(raw) > 65536:
                    raise DeployError("provider_response_too_large")
                return json.loads(raw)
        except DeployError:
            raise
        except Exception:
            raise DeployError("MAX_auth_or_transport_failed") from None

    def helper(self, mode):
        args = [
            "docker",
            "run",
            "--rm",
            "--network",
            "echo-max",
            "--user",
            "0",
            "--env-file",
            str(self.env / "postgres.env"),
            "--env-file",
            str(self.env / "migrations.env"),
            "--mount",
            f"type=bind,source={self.env}/passwords.json,target=/run/passwords.json,readonly",
            "--mount",
            f"type=bind,source={self.repo}/bootstrap/roles.sql,target=/run/roles.sql,readonly",
            "--mount",
            f"type=bind,source={self.repo}/ops/deploy/database.mjs,target=/app/database.mjs,readonly",
            "--entrypoint",
            "node",
            self.image,
            "/app/database.mjs",
            mode,
        ]
        return json.loads(self.host.run(args).stdout)

    def health(self):
        request = urllib.request.Request(
            f'http://127.0.0.1:{self.c["gateway_port"]}/ops/health',
            headers={"Authorization": "Bearer " + self.state["ops_token"]},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=5) as response:
            return json.load(response)

    def verify_public_dns(self):
        nonce = secrets.token_hex(24)
        file = self.path("/var/lib/echo-max/acme/.well-known/acme-challenge") / nonce
        atomic(file, nonce, 0o644)
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(
                "http://" + self.c["domain"] + "/.well-known/acme-challenge/" + nonce,
                timeout=10,
            ) as response:
                if response.read(1024).decode() != nonce:
                    raise DeployError("DNS_not_routed_to_this_host")
        except DeployError:
            raise
        except Exception:
            raise DeployError("public_HTTP_challenge_unreachable") from None
        finally:
            file.unlink(missing_ok=True)

    def apply(self):
        if os.geteuid() != 0 or platform.system() != "Linux":
            raise DeployError("root_on_Ubuntu_required")
        os_release = self.path("/etc/os-release").read_text()
        if "ID=ubuntu" not in os_release or 'VERSION_ID="24.04"' not in os_release:
            raise DeployError("Ubuntu_24_04_required")
        revision = (
            self.command("git", "-C", str(self.repo), "rev-parse", "HEAD")
            .stdout.decode()
            .strip()
        )
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise DeployError("committed_checkout_required")
        dirty = self.command(
            "git", "-C", str(self.repo), "status", "--porcelain", "--untracked-files=no"
        ).stdout
        if dirty:
            raise DeployError("clean_tracked_checkout_required")
        if self.env.is_symlink():
            raise DeployError("unmanaged_private_directory")
        marker = self.env / ".installer-managed"
        if self.env.exists() and any(self.env.iterdir()) and not marker.exists():
            raise DeployError("unmanaged_private_directory")
        if marker.exists() and (marker.is_symlink() or marker.read_text() != MANAGED):
            raise DeployError("unmanaged_private_directory")
        if self.state_path.exists():
            saved = private_json(self.state_path)
            identity = saved["identity"]
            if any(
                identity[k] != v
                for k, v in {
                    "revision": revision,
                    "domain": self.c["domain"],
                    "port": self.c["gateway_port"],
                }.items()
            ):
                raise DeployError("existing_installation_identity_conflict")
            if saved["completed"]:
                for role in ROLES:
                    env_file = self.env / (role + ".env")
                    if not env_file.is_file() or "RESTORE_FENCE=off" not in env_file.read_text().splitlines():
                        raise DeployError("runtime_fence_requires_operator")
        elif self.path("/etc/letsencrypt/live/echo-max").exists():
            raise DeployError("unmanaged_certificate_conflict")
        for r in ROLES:
            unit = self.path(f"/etc/systemd/system/echo-max-{r}.service")
            if (
                unit.is_symlink()
                or (unit.exists() and not unit.read_text().startswith(MANAGED))
                or self.path(f"/etc/systemd/system/echo-max-{r}.service.d").exists()
            ):
                raise DeployError("unmanaged_unit_conflict")
            fragment = self.command("systemctl", "show", f"echo-max-{r}.service", "--property=FragmentPath", "--value", allow_failure=True).stdout.decode().strip()
            dropins = self.command("systemctl", "show", f"echo-max-{r}.service", "--property=DropInPaths", "--value", allow_failure=True).stdout.decode().strip()
            if (fragment and fragment != str(unit)) or dropins:
                raise DeployError("unmanaged_unit_conflict")
        if not self.state_path.exists():
            with socket.socket() as s:
                try:
                    s.bind(("127.0.0.1", self.c["gateway_port"]))
                except OSError:
                    raise DeployError("gateway_port_in_use") from None
        self.event("dependencies")
        missing = [
            pkg
            for binary, pkg in [
                ("docker", "docker.io"),
                ("nginx", "nginx"),
                ("certbot", "certbot"),
                ("git", "git"),
            ]
            if not shutil.which(binary)
        ]
        if missing:
            self.command("apt-get", "update")
            self.command("apt-get", "install", "-y", *missing, "ca-certificates")
        self.command("systemctl", "enable", "--now", "docker")
        for kind, name in [
            ("network", "echo-max"),
            ("volume", "echo-max-pgdata"),
            ("container", "echo-max-postgres17"),
            *[("container", "echo-max-" + r) for r in ROLES],
        ]:
            self.docker_object(kind, name)
        self.event("MAX_CA_and_auth")
        certs = self.env / "certs"
        certs.mkdir(parents=True, exist_ok=True)
        self.env.chmod(0o700)
        atomic(marker, MANAGED)
        bundle = []
        for name in ("root", "sub"):
            url = f"https://gu-st.ru/content/lending/russian_trusted_{name}_ca_pem.crt"
            with urllib.request.urlopen(url, timeout=15) as response:
                raw = response.read(65537)
            if len(raw) > 65536 or b"BEGIN CERTIFICATE" not in raw:
                raise DeployError("invalid_MAX_CA")
            bundle.append(raw.decode().strip())
        atomic(certs / "max-ca.pem", "\n".join(bundle) + "\n", 0o644)
        me = self.api("/me")
        if me.get("is_bot") is not True or me.get("user_id") is None:
            raise DeployError("MAX_bot_identity_required")
        subs = self.api("/subscriptions").get("subscriptions", [])
        if any(s.get("url") != self.c["url"] for s in subs):
            raise DeployError("foreign_webhook_subscription")
        self.state = state_for(self.state_path, self.c, revision, me["user_id"])
        self.image = "echo-max:" + revision[:12]
        self.owned_runtime = any(self.path(f"/etc/systemd/system/echo-max-{r}.service").exists() for r in ROLES)
        write_envs(self.env, self.c, self.state)
        self.event("image")
        archive = self.command(
            "git",
            "-C",
            str(self.repo),
            "archive",
            revision,
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "src",
            "migrations",
            "deploy/Dockerfile",
        ).stdout
        self.command(
            "docker",
            "build",
            "-f",
            "deploy/Dockerfile",
            "-t",
            self.image,
            "--label",
            "org.echo-max.revision=" + revision,
            "-",
            data=archive,
        )
        self.event("PostgreSQL17")
        if not self.docker_object("network", "echo-max"):
            self.command(
                "docker", "network", "create", "--label", LABEL + "=true", "echo-max"
            )
        if not self.docker_object("volume", "echo-max-pgdata"):
            self.command(
                "docker",
                "volume",
                "create",
                "--label",
                LABEL + "=true",
                "echo-max-pgdata",
            )
        if not self.docker_object("container", "echo-max-postgres17"):
            self.command(
                "docker",
                "run",
                "-d",
                "--name",
                "echo-max-postgres17",
                "--label",
                LABEL + "=true",
                "--restart",
                "unless-stopped",
                "--network",
                "echo-max",
                "--env-file",
                str(self.env / "postgres.env"),
                "--mount",
                "source=echo-max-pgdata,target=/var/lib/postgresql/data",
                "--memory",
                "256m",
                "--memory-swap",
                "384m",
                PG_IMAGE,
                "-c",
                "shared_buffers=32MB",
                "-c",
                "max_connections=50",
                "-c",
                "work_mem=2MB",
            )
        else:
            self.command("docker", "start", "echo-max-postgres17")
        self.wait(
            lambda: self.command(
                "docker",
                "exec",
                "echo-max-postgres17",
                "pg_isready",
                "-U",
                "postgres",
                "-d",
                "echo_max",
                allow_failure=True,
            ).returncode
            == 0
        )
        self.event("roles_and_migrations")
        db = self.helper("prepare")
        if db["restored"] or (self.state["completed"] and db["fenced"]):
            raise DeployError("restore_or_manual_fence_requires_operator")
        self.event("nginx_TLS")
        self.configure_nginx()
        self.event("four_runtimes")
        for r in ROLES:
            managed_write(
                self.path(f"/etc/systemd/system/echo-max-{r}.service"),
                runtime_unit(self.repo, r, self.image, self.c["gateway_port"]),
            )
        self.owned_runtime = True
        self.command("systemctl", "daemon-reload")
        self.command("systemctl", "enable", "--now", "echo-max-gateway.service")
        self.wait(lambda: self.health().get("schemaVersion") == db["schemaVersion"])
        self.helper("open-repeat" if self.state["completed"] else "open-first")
        for r in ROLES:
            p = self.env / (r + ".env")
            atomic(p, p.read_text().replace("RESTORE_FENCE=on", "RESTORE_FENCE=off"))
        self.command(
            "systemctl",
            "enable",
            "--now",
            *["echo-max-" + r + ".service" for r in ROLES],
        )
        self.command(
            "systemctl", "restart", *["echo-max-" + r + ".service" for r in ROLES]
        )
        self.event("webhook")
        self.wait(
            lambda: self.health().get("ready") is True
            and self.health().get("subscription", {}).get("status") == "healthy",
            40,
        )
        matching = [
            s
            for s in self.api("/subscriptions").get("subscriptions", [])
            if s.get("url") == self.c["url"]
        ]
        if len(matching) != 1 or set(matching[0].get("update_types", [])) != {
            "message_created",
            "message_callback",
            "bot_started",
            "bot_stopped",
        }:
            raise DeployError("webhook_verification_failed")
        self.state["completed"] = True
        atomic(self.state_path, json.dumps(self.state))
        self.event("ready")

    def configure_nginx(self):
        c = self.c
        site = self.path("/etc/nginx/conf.d/echo-max.conf")
        existing = self.command("nginx", "-T", allow_failure=True)
        # Refuse domain collisions outside the installer-owned file.
        dump = existing.stdout.decode(errors="replace")
        for block in re.split(r"# configuration file ", dump):
            if str(site) not in block.split("\n", 1)[0] and re.search(
                r"server_name\s+[^;]*\b" + re.escape(c["domain"]) + r"\b", block
            ):
                raise DeployError("nginx_domain_conflict")
        http = (
            MANAGED
            + f'server {{ listen 80; server_name {c["domain"]}; location ^~ /.well-known/acme-challenge/ {{ root /var/lib/echo-max/acme; }} location / {{ return 404; }} }}\n'
        )
        self.path("/var/lib/echo-max/acme").mkdir(parents=True, exist_ok=True)
        old = site.read_text() if site.exists() else None
        try:
            # Keep an existing TLS listener during renewal/repeat; bootstrap HTTP only once.
            managed_write(site, old if old is not None else http)
            self.command("nginx", "-t")
            self.command("systemctl", "enable", "--now", "nginx")
            self.command("systemctl", "reload", "nginx")
            self.verify_public_dns()
            self.command(
                "certbot",
                "certonly",
                "--webroot",
                "-w",
                "/var/lib/echo-max/acme",
                "--non-interactive",
                "--agree-tos",
                "--keep-until-expiring",
                "--email",
                c["email"],
                "-d",
                c["domain"],
                "--cert-name",
                "echo-max",
            )
            locations = (
                (self.repo / "deploy/nginx/echo-max.conf")
                .read_text()
                .replace("127.0.0.1:8080", f'127.0.0.1:{c["gateway_port"]}')
            )
            tls = f'server {{ listen 443 ssl; server_name {c["domain"]}; ssl_certificate /etc/letsencrypt/live/echo-max/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/echo-max/privkey.pem;\n{locations}\n}}\n'
            managed_write(site, http + tls)
            self.command("nginx", "-t")
            self.command("systemctl", "reload", "nginx")
            hook = self.path("/etc/letsencrypt/renewal-hooks/deploy/echo-max-reload")
            managed_write(
                hook,
                "#!/bin/sh\n"
                + MANAGED
                + '[ "$RENEWED_LINEAGE" != /etc/letsencrypt/live/echo-max ] || systemctl reload nginx\n',
            )
            hook.chmod(0o755)
            self.command("systemctl", "enable", "--now", "certbot.timer")
            with socket.create_connection((c["domain"], 443), timeout=10) as conn:
                with ssl.create_default_context().wrap_socket(
                    conn, server_hostname=c["domain"]
                ):
                    pass
        except Exception:
            # Only restore files actually owned by this installer.
            if old is not None and not old.startswith(MANAGED):
                raise
            if old is None:
                site.unlink(missing_ok=True)
            else:
                atomic(site, old, 0o644)
            self.command("nginx", "-t", allow_failure=True)
            self.command("systemctl", "reload", "nginx", allow_failure=True)
            raise

    def fence_on_failure(self):
        if not self.owned_runtime:
            return
        for r in ROLES:
            p = self.env / (r + ".env")
            if p.exists():
                atomic(
                    p, p.read_text().replace("RESTORE_FENCE=off", "RESTORE_FENCE=on")
                )
        self.command(
            "systemctl",
            "stop",
            *["echo-max-" + r + ".service" for r in ROLES],
            allow_failure=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    installer = None
    lock = None
    try:
        c = load_config(args.config)
        if args.plan:
            print(json.dumps(plan(c)))
            return 0
        if os.geteuid() != 0:
            raise DeployError("root_required")
        lock = open("/var/lock/echo-max-deploy.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise DeployError("another_installation_running") from None
        installer = Installer(c, Path(__file__).resolve().parents[2])
        installer.apply()
        return 0
    except Exception as error:
        if installer:
            try:
                installer.fence_on_failure()
            except Exception:
                pass
        code = str(error) if isinstance(error, DeployError) else "deployment_failed"
        print(
            json.dumps(
                {
                    "deploy": "failed",
                    "phase": installer.phase if installer else "config",
                    "code": code,
                }
            ),
            file=sys.stderr,
        )
        return 1
    finally:
        if lock:
            lock.close()


if __name__ == "__main__":
    sys.exit(main())
