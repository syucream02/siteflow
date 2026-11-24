import fs from 'node:fs';
import { need, REPOSITORY, hash } from './contract.mjs';
import { schemaHash } from '../schema-hash.mjs';
const e=process.env;
try{
  need(e.GITHUB_REPOSITORY===REPOSITORY&&e.GITHUB_EVENT_NAME==='push'&&e.GITHUB_REF==='refs/heads/main'&&/^[a-f0-9]{40}$/.test(e.GITHUB_SHA??''),'MAIN_CI_REQUIRED');
  need([e.SITEFLOW_APP_DIGEST,e.SITEFLOW_MIGRATION_DIGEST].every(v=>/^sha256:[a-f0-9]{64}$/.test(v??'')),'INVALID_DIGEST');
  need(/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ATTEMPT??''),'INVALID_CI_RUN');
  fs.writeFileSync('ci-images.json',JSON.stringify({sha:e.GITHUB_SHA,digest:e.SITEFLOW_APP_DIGEST,migrationDigest:e.SITEFLOW_MIGRATION_DIGEST,schemaHash:schemaHash(),ciRunId:e.GITHUB_RUN_ID,ciAttempt:Number(e.GITHUB_RUN_ATTEMPT),workflowHash:hash(fs.readFileSync('.github/workflows/ci.yml','utf8').replaceAll('\r\n','\n'))}),{flag:'wx'});
}catch{console.error('CI_IMAGE_RECORD_REJECTED');process.exitCode=1;}
