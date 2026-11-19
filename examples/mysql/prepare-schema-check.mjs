import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevelopmentSettings, readSchemaCheckSettings, schemaCheckEnvPath } from "./schema-check-settings.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const statusOnly = process.argv.includes("--status");

try {
  if (!existsSync(schemaCheckEnvPath)) {
    if (statusOnly) throw new Error("Not prepared");
    execFileSync("git", ["check-ignore", "--quiet", ".env.schema-check.local"], { cwd: root, stdio: "pipe" });
    const development = readDevelopmentSettings();
    const tag = randomBytes(4).toString("hex");
    writeFileSync(schemaCheckEnvPath, [
      "SITEFLOW_SCHEMA_CHECK=1",
      `SCHEMA_CHECK_DATABASE=siteflow_check_${Date.now().toString(36)}_${tag}`,
      `SCHEMA_CHECK_USER=sfcheck_${tag}`,
      `SCHEMA_CHECK_PASSWORD=${randomBytes(24).toString("hex")}`,
      `SCHEMA_CHECK_PORT=${development.MYSQL_PORT ?? "3307"}`,
      "",
    ].join("\n"), { flag: "wx", mode: 0o600 });
  }

  const settings = readSchemaCheckSettings();
  const development = readDevelopmentSettings();
  const developmentDatabase = development.MYSQL_DATABASE;
  if (!developmentDatabase || !/^[A-Za-z0-9_]{1,64}$/.test(developmentDatabase)) throw new Error("Invalid development database");
  const docker = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "", "Programs/DockerDesktop/resources/bin/docker.exe")
    : "docker";
  const container = execFileSync(docker, [
    "compose", "--env-file", path.join(root, ".env.mysql.local"), "-f", path.join(root, "compose.dev.yaml"), "ps", "-q", "mysql",
  ], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error("MySQL is not running");

  // 資格情報はコマンド引数にせず標準入力で渡す。rootの秘密値はコンテナ内で読む。
  const setupSql = statusOnly ? "" : [
    `CREATE DATABASE IF NOT EXISTS \`${settings.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${settings.user}'@'%' IDENTIFIED BY '${settings.password}';`,
    `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON \`${settings.database}\`.* TO '${settings.user}'@'%';`,
  ].join("\n");
  const query = `${setupSql}\nSELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${developmentDatabase}';\nSELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${settings.database}';\n`;
  const output = execFileSync(docker, [
    "exec", "-i", container, "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=socket --user=root --batch --skip-column-names',
  ], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const counts = output.trim().split(/\s+/);
  if (counts.length !== 2 || counts.some((value) => !/^\d+$/.test(value))) throw new Error("Unexpected MySQL result");
  console.log(statusOnly ? "Schema-check status:" : "Dedicated schema-check DB/user prepared; existing DB is unchanged.");
  console.log(`Existing development DB table count: ${counts[0]}`);
  console.log(`Schema-check DB table count: ${counts[1]}`);
} catch {
  // SQLエラーにはCREATE USERの入力が含まれる可能性があるので、元のエラーを出さない。
  console.error("検証用DBの準備・確認に失敗しました。Docker/MySQLの稼働とローカル設定を確認してください。資格情報は出力しません。");
  process.exitCode = 1;
}
