import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '../../tests/meeting-check.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, SITEFLOW_MEETING_CHECK: '1' }, windowsHide: true,
});
process.exitCode = result.status ?? 1;
