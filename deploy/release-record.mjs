import fs from 'node:fs';
import { schemaHash } from './schema-hash.mjs';
export function releaseEnabled(value) {
  if (value === 'true') return true;
  if (value === undefined || value === '' || value === 'false') return false;
  throw Error('INVALID_RELEASE_SWITCH');
}
export function createReleaseRecord(env) {
  if (env.SITEFLOW_RELEASE_ENABLED !== 'true' || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_REPOSITORY !== 'syucream02/siteflow' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw Error('RELEASE_NOT_APPROVED');
  for (const key of ['SITEFLOW_IMAGE_DIGEST','SITEFLOW_MIGRATION_DIGEST']) if (!/^sha256:[a-f0-9]{64}$/.test(env[key] ?? '')) throw Error('INVALID_DIGEST');
  if(!/^[a-f0-9]{64}$/.test(env.SITEFLOW_SCHEMA_HASH??''))throw Error('INVALID_SCHEMA_HASH');
  return { schemaVersion: 1, repository: env.GITHUB_REPOSITORY, workflow: '.github/workflows/ci.yml', sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, imageRepository: 'ghcr.io/syucream02/siteflow',
    digest: env.SITEFLOW_IMAGE_DIGEST, migrationDigest: env.SITEFLOW_MIGRATION_DIGEST, schemaHash:env.SITEFLOW_SCHEMA_HASH, approved: true };
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/deploy/release-record.mjs') || process.argv[1] === 'deploy/release-record.mjs') {
  try {
    if (process.argv[2] === '--check-gate') {
      if (!process.env.GITHUB_OUTPUT) throw Error('CI_CONTEXT_REQUIRED');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${releaseEnabled(process.env.SITEFLOW_RELEASE_ENABLED)}\n`);
    } else fs.writeFileSync('approved-release.json', JSON.stringify(createReleaseRecord({...process.env,SITEFLOW_SCHEMA_HASH:schemaHash()}), null, 2), { flag: 'wx' });
  }
  catch { console.error('RELEASE_RECORD_REJECTED'); process.exitCode = 1; }
}
