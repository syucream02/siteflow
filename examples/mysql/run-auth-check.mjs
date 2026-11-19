import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "--env-file=../../.env.schema-check.local", "--import", "tsx", "--test", "../../tests/auth-check.test.mjs",
], { stdio: "inherit", env: { ...process.env, SITEFLOW_AUTH_CHECK: "1" }, windowsHide: true });
process.exitCode = result.status ?? 1;
