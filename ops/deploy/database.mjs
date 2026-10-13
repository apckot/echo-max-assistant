import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { runMigrations } from "/app/dist/infrastructure/postgres/migrations.js";

export async function installDatabase({
  adminUrl,
  migrationsUrl,
  passwords,
  bootstrap,
  migrations,
  mode,
}) {
  const admin = new pg.Pool({ connectionString: adminUrl });
  const migrator = new pg.Pool({ connectionString: migrationsUrl });
  const client = await admin.connect();
  try {
    await client.query("SELECT pg_advisory_lock(1296127058,1698727768)");
    const expected = (await readdir(migrations)).filter((n) =>
      n.endsWith(".sql"),
    ).length;
    if (mode === "prepare") {
      const present = (
        await client.query(
          "SELECT to_regclass('public.system_state') IS NOT NULL AS present",
        )
      ).rows[0].present;
      await client.query("BEGIN");
      try {
        for (const role of [
          "migrator",
          "gateway",
          "worker",
          "delivery",
          "scheduler",
        ]) {
          const name = "echo_" + role;
          const row = (
            await client.query(
              "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1",
              [name],
            )
          ).rows[0];
          if (row) {
            if (Object.values(row).some(Boolean))
              throw new Error("unsafe_existing_role");
          } else {
            if (!/^[a-f0-9]{48}$/.test(passwords[role]))
              throw new Error("invalid_generated_password");
            const clause = bootstrap
              .split("\n")
              .find((line) => line.startsWith("CREATE ROLE " + name + " "));
            if (!clause) throw new Error("bootstrap_role_missing");
            await client.query(clause);
            await client.query(
              `ALTER ROLE ${name} PASSWORD ${client.escapeLiteral(passwords[role])}`,
            );
          }
        }
        await client.query(
          bootstrap.slice(bootstrap.indexOf("DO $bootstrap$")),
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      await runMigrations(migrator, migrations);
      if (!present)
        await client.query(
          "UPDATE public.system_state SET restore_fence=true WHERE id=1",
        );
    } else if (!["open-first", "open-repeat"].includes(mode))
      throw new Error("invalid_install_mode");
    await client.query("BEGIN");
    try {
      const row = (
        await client.query(
          "SELECT schema_version,restore_fence,restored_snapshot_at,deployment_epoch FROM public.system_state WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      if (!row || row.schema_version !== expected)
        throw new Error("schema_version_mismatch");
      const restored =
        row.restored_snapshot_at !== null ||
        BigInt(row.deployment_epoch) !== 0n;
      if (mode !== "prepare") {
        if (restored || (mode === "open-repeat" && row.restore_fence))
          throw new Error("operator_reopen_required");
        await client.query(
          "UPDATE public.system_state SET restore_fence=false WHERE id=1",
        );
      }
      await client.query("COMMIT");
      return {
        schemaVersion: expected,
        fenced: mode === "prepare" ? row.restore_fence : false,
        restored,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(1296127058,1698727768)");
    } finally {
      client.release();
      await migrator.end();
      await admin.end();
    }
  }
}

if (process.argv[1]?.endsWith("/database.mjs")) {
  try {
    const passwords = JSON.parse(await readFile("/run/passwords.json", "utf8"));
    const adminUrl = `postgres://postgres:${process.env.POSTGRES_PASSWORD}@echo-max-postgres17:5432/echo_max`;
    const result = await installDatabase({
      adminUrl,
      migrationsUrl: process.env.DATABASE_URL_MIGRATIONS,
      passwords,
      bootstrap: await readFile("/run/roles.sql", "utf8"),
      migrations: "/app/migrations",
      mode: process.argv[2],
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(JSON.stringify({ deploymentDatabase: "failed" }));
    process.exitCode = 1;
  }
}
