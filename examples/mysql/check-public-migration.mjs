import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createTlsMysqlFixture } from './tls-mysql-fixture.mjs';
import { isLocalDockerEndpoint } from './backup-check-settings.mjs';

const docker = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DockerDesktop/resources/bin/docker.exe') : 'docker';
const call = args => execFileSync(docker, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000 });
const endpoint = call(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();
if (!isLocalDockerEndpoint(endpoint,process.platform) || (process.env.DOCKER_HOST && !isLocalDockerEndpoint(process.env.DOCKER_HOST,process.platform))) throw Error('LOCAL_DOCKER_REQUIRED');
const name = 'siteflow-docker-check-' + randomBytes(6).toString('hex');
const proxyCheck=process.argv.includes('--proxy');
const resultFile=proxyCheck?'work/deploy-proxy-check.json':'work/public-migration-check.json';
fs.rmSync(resultFile,{force:true});
if(proxyCheck)fs.rmSync('work/deploy-proxy-diagnostic.log',{force:true});
let network=false, volume=false, fixture;
try {
  call(['network','create','--label','siteflow.check=public-migration',name]);network=true;
  call(['volume','create','--label','siteflow.check=public-migration',name]);volume=true;
  fixture=await createTlsMysqlFixture({networkName:name,volumeName:name,migrationImage:process.env.SITEFLOW_MIGRATION_IMAGE ?? 'siteflow:migration-check-20261116'});
  if(proxyCheck){
    const values={...fixture.env,SITEFLOW_LOCAL_PROXY_TEST_APPROVED:'yes',SITEFLOW_DB_HOST:'mysql.siteflow.test',SITEFLOW_DB_PORT:'3306',SITEFLOW_DB_CA_FILE:'/run/siteflow/ca.pem',SITEFLOW_MIGRATION_RECEIPT:JSON.stringify(fixture.migrationReceipt)};
    const privateInput=JSON.stringify({password:values.SITEFLOW_DB_PASSWORD,authSecret:values.SITEFLOW_AUTH_SECRET});
    delete values.SITEFLOW_DB_PASSWORD;delete values.SITEFLOW_AUTH_SECRET;
    let output;
    try {
      output=execFileSync(docker,['run','--rm','--interactive','--pull=never','--network',name,'--memory','512m','--memory-swap','512m','--ulimit','core=0','--log-driver','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777','--tmpfs','/srv/siteflow-mysql:rw,nosuid,nodev,size=8m,mode=0755','--tmpfs','/run:rw,nosuid,nodev,size=8m,mode=0755','--tmpfs','/var/lib/nginx:rw,nosuid,nodev,size=16m','--tmpfs','/var/log/nginx:rw,nosuid,nodev,size=8m','--mount',`type=bind,source=${fixture.env.SITEFLOW_DB_CA_FILE},target=/run/siteflow/ca.pem,readonly`,...Object.keys(values).flatMap(key=>['--env',key]),'siteflow:proxy-check-20261116'],{env:{...process.env,...values},input:privateInput,encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:180000});
    } catch {
      // 検証専用プロセスのstderrのみ。接続設定・execのenv/引数は保存しない。
      fs.writeFileSync('work/deploy-proxy-diagnostic.log','LOCAL_PROXY_PROCESS_FAILED; raw stderr withheld\n');
      throw Error('LOCAL_PROXY_PROCESS_FAILED');
    }
    const result=JSON.parse(output.trim().split('\n').at(-1));
    if(!result.passed)throw Error('PROXY_CHECK_FAILED');
    fs.writeFileSync('work/deploy-proxy-check.json',JSON.stringify(result,null,2));
    console.log(`PASS: ${result.checks.length} real Nginx/Next.js switch checks`);
  }else{
  const result={passed:true,checks:fixture.checks,tls:fixture.tlsVersion,scope:'disposable Docker MySQL + public migration image; not AWS'};
  fs.writeFileSync('work/public-migration-check.json',JSON.stringify(result,null,2));
  console.log(`PASS: ${fixture.checks.length} public migration/TLS checks`);
  }
} catch(error) {
  console.error(error.message?.startsWith('TLS_FIXTURE_FAILED_')?error.message:proxyCheck?'PUBLIC_PROXY_CHECK_FAILED':'PUBLIC_MIGRATION_CHECK_FAILED');process.exitCode=1;
} finally {
  const results=await Promise.allSettled([fixture?.close()]);
  try { if(volume)call(['volume','rm',name]); } catch { results.push({status:'rejected'}); }
  try { if(network)call(['network','rm',name]); } catch { results.push({status:'rejected'}); }
  if(results.some(r=>r.status==='rejected')) {console.error('PUBLIC_MIGRATION_CLEANUP_FAILED');process.exitCode=1;}
  if(process.exitCode)fs.rmSync(resultFile,{force:true});
}
