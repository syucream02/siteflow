import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isLocalDockerEndpoint } from '../examples/mysql/backup-check-settings.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.platform==='win32'?path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe'):'docker';
const call=(args,env)=>execFileSync(docker,args,{cwd:root,env:env??process.env,encoding:'utf8',stdio:'pipe',windowsHide:true,timeout:30000});
const endpoint=call(['context','inspect','--format','{{.Endpoints.docker.Host}}']).trim();
if(!isLocalDockerEndpoint(endpoint,process.platform)||(process.env.DOCKER_HOST&&!isLocalDockerEndpoint(process.env.DOCKER_HOST,process.platform)))throw Error('LOCAL_DOCKER_REQUIRED');
fs.mkdirSync(path.join(root,'work'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'work','compose-config-check-'));
try{
  fs.writeFileSync(path.join(directory,'empty.env'),'');
  fs.writeFileSync(path.join(directory,'runtime.env'),'FIXTURE_VALUE=fictional_only\n');
  fs.writeFileSync(path.join(directory,'ca.pem'),'PUBLIC_CERT_PLACEHOLDER');
  fs.writeFileSync(path.join(directory,'root-password'),'FICTIONAL_ONLY');
  const env={...process.env,SITEFLOW_APP_IMAGE:'ghcr.io/syucream02/siteflow@sha256:'+'a'.repeat(64),SITEFLOW_MYSQL_IMAGE:'mysql@sha256:'+'b'.repeat(64),
    SITEFLOW_RUNTIME_ENV_FILE:path.join(directory,'runtime.env'),SITEFLOW_DB_CA_FILE:path.join(directory,'ca.pem'),SITEFLOW_MYSQL_TLS_DIRECTORY:directory,
    SITEFLOW_MYSQL_ROOT_PASSWORD_FILE:path.join(directory,'root-password'),SITEFLOW_MYSQL_CLIENT_CONFIG_FILE:path.join(directory,'root-client.cnf'),SITEFLOW_MYSQL_LOG_DIRECTORY:directory,SITEFLOW_MYSQL_VOLUME:'siteflow-config-check-volume',SITEFLOW_DATABASE_NETWORK:'siteflow-config-check-network'};
  const args=['compose','--env-file',path.join(directory,'empty.env'),'-f','deploy/compose.production.yaml','--profile','database','--profile','blue','--profile','green','config','--format','json','--no-env-resolution'];
  const config=JSON.parse(call(args,env));
  assert.equal(config.services.mysql.ports,undefined);assert.equal(config.volumes['mysql-data'].external,true);assert.equal(config.networks.database.external,true);
  for(const [slot,port]of [['blue','3101'],['green','3102']]){
    assert.equal(config.services[slot].ports[0].host_ip,'127.0.0.1');assert.equal(String(config.services[slot].ports[0].published),port);
    assert.equal(config.services[slot].ports[0].target,3000);assert.equal(Number(config.services[slot].mem_limit),384*1024*1024);
    assert.equal(config.services[slot].volumes[0].read_only,true);assert.equal(config.services[slot].volumes[0].bind.create_host_path,false);
  }
  assert.equal(Number(config.services.mysql.mem_limit),512*1024*1024);
  assert.equal(config.services.mysql.restart,'no');
  assert.equal(config.services.blue.restart,'no');
  assert.equal(config.services.green.restart,'no');
  assert.equal(config.services.mysql.stop_grace_period,'1m0s');
  assert.ok(config.services.mysql.healthcheck.test[1].includes('SELECT 1'));
  for(const service of ['blue','green']){
    assert.equal(config.services[service].logging.driver,'none');
    assert.equal(config.services[service].read_only,true);
    assert.equal(config.services[service].environment.SITEFLOW_DB_PASSWORD_FILE,'/run/secrets/db-password');
    assert.equal(config.services[service].environment.SITEFLOW_AUTH_SECRET_FILE,'/run/secrets/auth-secret');
    assert.ok(config.services[service].volumes.every(v=>v.read_only&&v.bind.create_host_path===false));
  }
  assert.equal(config.services.mysql.logging.driver,'none');
  assert.equal(config.services.mysql.read_only,true);
  // Compose may omit zero-valued soft/hard fields from its normalized JSON.
  const core=config.services.mysql.ulimits.core;
  assert.ok(core!==undefined);
  assert.equal(Number(typeof core==='object'?(core.hard??0):core),0);
  assert.equal(config.services.mysql.environment.MYSQL_ROOT_HOST,'localhost');
  const invalid={...env,SITEFLOW_MYSQL_VOLUME:''};let rejected=false;
  try{call(args,invalid);}catch{rejected=true;}assert.ok(rejected);
  fs.writeFileSync(path.join(root,'work','deploy-compose-check.json'),JSON.stringify({passed:true,checks:['real Docker Compose config accepts profiles and merges','external volume/network required','MySQL has no published port; apps loopback only','memory and readonly bind constraints','missing volume variable rejected'],scope:'configuration validation only; no Compose services started'},null,2));
  console.log('PASS: 5 Docker Compose configuration checks; no services started');
}finally{
  if(path.dirname(path.resolve(directory))!==path.resolve(root,'work')||!path.basename(directory).startsWith('compose-config-check-'))throw Error('INVALID_TEMP_PATH');
  fs.rmSync(directory,{recursive:true,force:true});
}
