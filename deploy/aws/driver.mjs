import fs from 'node:fs';
import path from 'node:path';
import { execute, processEnvironment } from './external.mjs';
import { fileURLToPath } from 'node:url';
import { need, IMAGE_REPOSITORY, hash } from './contract.mjs';
import { ReleaseLock } from './release-lock.mjs';

const ports={legacy:3002,blue:3101,green:3102};
export const route=(slot)=>{need(Object.hasOwn(ports,slot),'INVALID_SLOT');return `proxy_pass http://127.0.0.1:${ports[slot]};\nset $siteflow_slot ${slot};\n`;};
export function privateFile(file){const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&(s.mode&0o077)===0,'UNTRUSTED_STATE_FILE');return fs.readFileSync(file,'utf8');}
export function atomic(file,value){const temporary=file+'.next';fs.writeFileSync(temporary,value,{mode:0o600,flag:'wx'});const fd=fs.openSync(temporary,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);if(process.platform==='linux'){const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}}
export class ReleaseDriver {
  constructor(config,m){
    need(process.platform==='linux'&&process.getuid()===0,'LINUX_ROOT_REQUIRED');
    this.config=config;this.m=m;this.root=config.stateDirectory;
    need(this.root==='/srv/siteflow-mysql/release-aws'&&config.upstreamFile==='/etc/nginx/siteflow/upstream.inc'&&config.publicOrigin==='https://siteflow.example.invalid','UNTRUSTED_RUNTIME_PATHS');
    const s=fs.lstatSync(this.root);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&(s.mode&0o077)===0,'UNTRUSTED_STATE_DIRECTORY');
    this.env=processEnvironment('ec2');this.env.DOCKER_HOST='unix:///var/run/docker.sock';
    this.env.SITEFLOW_MYSQL_DATA_MOUNT='/srv/siteflow-mysql';this.env.SITEFLOW_MYSQL_FS_UUID='REQUIRES_APPROVED_EBS_UUID';this.env.SITEFLOW_MYSQL_EBS_VOLUME_ID='REQUIRES_APPROVED_EBS_VOLUME_ID';
    this.journal=path.join(this.root,`${m.releaseId}.json`);
    this.read=privateFile;this.write=atomic;
    this.guard=new ReleaseLock(this.root,m.releaseId,{read:this.read,write:this.write});
  }
  tool(file,args,signal,timeout=15000){return execute(file,args,{env:this.env,signal,timeout});}
  async lock(recovery=false){
    // Never make an old journal current again, even if a duplicate SSM request
    // arrives while its lease is still valid. Recovery uses the explicit path.
    if(!recovery)need(!fs.existsSync(this.journal),'RELEASE_ALREADY_RECORDED');
    this.guard.acquire(recovery);
  }
  async unlock(){this.guard.release();}
  holdLock(){this.guard.hold();}
  save(status){this.write(this.journal,JSON.stringify({status,manifest:this.m,old:this.old,before:this.before,name:this.name,port:this.port,slot:this.slot,releaseId:this.m.releaseId}));}
  async markIncident(status){this.write(path.join(this.root,'incident.json'),JSON.stringify({releaseId:this.m.releaseId,status}));}
  async preflight(m){
    need(fs.existsSync(path.join(this.root,'enabled'))&&!fs.existsSync(path.join(this.root,'paused'))&&!fs.existsSync(path.join(this.root,'incident.json')),'LOCAL_RELEASE_PAUSED');
    const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    await this.tool('bash',[path.join(base,'check-database-mount.sh')]);
    const group=(await this.tool('cat',['/proc/self/cgroup'])).split('\n').find(x=>x.startsWith('0::'))?.slice(3);
    need(group?.startsWith('/')&&!group.includes('..')&&fs.readFileSync(`/sys/fs/cgroup${group}/memory.swap.max`,'utf8').trim()==='0','NO_SWAP_REQUIRED');
    need(/Max core file size\s+0\s+0\s+bytes/.test(fs.readFileSync('/proc/self/limits','utf8')),'CORE_DUMP_NOT_DISABLED');
    const c=this.config.runtime;
    need(c&&c.databaseName==='siteflow_public_app'&&c.databaseHost==='mysql.siteflow.test'&&c.network==='siteflow-production-database','DATABASE_TARGET_MISMATCH');
    for(const p of [c.runtimeEnvFile,c.databasePasswordFile,c.authSecretFile,c.caFile])need(p?.startsWith('/srv/siteflow-mysql/')&&!p.includes('..'),'SECRET_PATH_MISMATCH');
    await this.tool('bash',[path.join(base,'check-app-secrets.sh'),c.runtimeEnvFile,c.databasePasswordFile,c.authSecretFile]);
    this.old=JSON.parse(this.read(path.join(this.root,'current.json')));
    need(ports[this.old.slot]===this.old.port,'CURRENT_SLOT_MISMATCH');
    this.before=fs.readFileSync(this.config.upstreamFile,'utf8');need(this.before.trim()===route(this.old.slot).trim(),'UPSTREAM_STATE_MISMATCH');
    const u=fs.lstatSync(this.config.upstreamFile);need(u.isFile()&&!u.isSymbolicLink()&&u.uid===0&&(u.mode&0o022)===0,'UNTRUSTED_UPSTREAM');
    this.slot=this.old.slot==='blue'?'green':'blue';this.port=ports[this.slot];
    this.name=`siteflow-aws-${this.slot}-${m.deployRunId}`;
    this.receipt=JSON.parse(this.read(path.join(this.root,'schema.json')));
    this.receipt.caMatches=this.receipt.caSha256===hash(fs.readFileSync(c.caFile));
    this.dockerDirectory=path.join(this.root,`${m.releaseId}.docker`);fs.mkdirSync(this.dockerDirectory,{mode:0o700});this.env.DOCKER_CONFIG=this.dockerDirectory;
    this.save('RUNNING');
  }
  async inspect(image){
    const revision=(await this.tool('docker',['image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image])).trim();
    return {repository:IMAGE_REPOSITORY,digest:image.split('@')[1],revision};
  }
  async pull(m,signal){
    for(const digest of [m.digest,m.migrationDigest])await this.tool('docker',['pull',`${IMAGE_REPOSITORY}@${digest}`],signal,60000);
    return {image:await this.inspect(`${IMAGE_REPOSITORY}@${m.digest}`),migration:await this.inspect(`${IMAGE_REPOSITORY}@${m.migrationDigest}`),receipt:this.receipt};
  }
  async stage(m,signal){
    const saved=path.join(this.root,'candidate.json');
    if(m.mode==='publish'){
      need(fs.existsSync(saved),'COMPLETED_CANDIDATE_REQUIRED');
      const candidate=JSON.parse(this.read(saved));
      need(candidate.status==='CANDIDATE_READY'&&candidate.releaseId!==m.releaseId&&/^deploy-[1-9][0-9]{0,19}-1$/.test(candidate.releaseId)&&candidate.schemaHash===m.schemaHash&&candidate.migrationDigest===m.migrationDigest&&candidate.sha===m.sha&&candidate.digest===m.digest&&candidate.port===this.port&&candidate.slot===this.slot&&/^siteflow-aws-(blue|green)-[1-9][0-9]{0,19}$/.test(candidate.name),'CANDIDATE_RECEIPT_MISMATCH');
      const actual=(await this.tool('docker',['inspect','--format','{{.State.Running}}|{{.Image}}|{{index .Config.Labels "siteflow.managed"}}',candidate.name])).trim();
      need(actual.startsWith('true|')&&actual.endsWith('|aws-release'),'CANDIDATE_NOT_RUNNING');
      const digest=(await this.tool('docker',['inspect','--format','{{.Config.Image}}',candidate.name])).trim();need(digest===`${IMAGE_REPOSITORY}@${m.digest}`,'CANDIDATE_IMAGE_MISMATCH');
      const binding=JSON.parse(await this.tool('docker',['inspect','--format','{{json .HostConfig.PortBindings}}',candidate.name]));
      need(JSON.stringify(binding)===JSON.stringify({'3000/tcp':[{HostIp:'127.0.0.1',HostPort:String(this.port)}]}),'CANDIDATE_BINDING_MISMATCH');
      need((await this.tool('docker',['inspect','--format','{{.HostConfig.NetworkMode}}',candidate.name])).trim()===this.config.runtime.network,'CANDIDATE_NETWORK_MISMATCH');
      this.name=candidate.name;this.adopted=true;return;
    }
    const c=this.config.runtime;
    const args=['run','--detach','--name',this.name,'--label','siteflow.managed=aws-release','--network',c.network,'--env-file',c.runtimeEnvFile,'--env','NODE_ENV=production','--env','HOSTNAME=0.0.0.0','--env','PORT=3000','--env','SITEFLOW_WORKSPACE_MODE=public-integrated','--env',`SITEFLOW_PUBLIC_ORIGIN=${this.config.publicOrigin}`,'--env','SITEFLOW_DB_TLS=required','--env','SITEFLOW_DB_CA_FILE=/run/siteflow/ca.pem','--env',`SITEFLOW_DB_HOST=${c.databaseHost}`,'--env',`SITEFLOW_DB_NAME=${c.databaseName}`,'--env','SITEFLOW_DB_PORT=3306','--mount',`type=bind,source=${c.caFile},target=/run/siteflow/ca.pem,readonly`,'--mount',`type=bind,source=${c.databasePasswordFile},target=/run/secrets/db-password,readonly`,'--mount',`type=bind,source=${c.authSecretFile},target=/run/secrets/auth-secret,readonly`,'--memory','384m','--memory-swap','384m','--read-only','--ulimit','core=0','--tmpfs','/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=1777','--log-driver','none','--restart','no','--publish',`127.0.0.1:${this.port}:3000`,`${IMAGE_REPOSITORY}@${m.digest}`];
    await this.tool('docker',args,signal,30000);this.created=true;
  }
  async ready(m,signal){
    for(let i=0;i<30;i++){
      need(!signal.aborted,'RELEASE_ABORTED');
      try{const body=await this.tool('curl',['--disable','--fail','--silent','--max-time','3','--header','Host: siteflow.example.invalid','--header','X-Forwarded-Proto: https',`http://127.0.0.1:${this.port}/api/ready`],signal,4000);if(JSON.parse(body).ok===true)return;}catch{need(!signal.aborted,'RELEASE_ABORTED');}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }throw new Error('READINESS_FAILED');
  }
  async switchRoute(m,signal,check){
    const guard=async()=>{need(!signal.aborted,'RELEASE_ABORTED');await check();need(!signal.aborted,'RELEASE_ABORTED');};
    await guard();this.save('SWITCHING');await guard();this.write(this.config.upstreamFile,route(this.slot));
    await guard();await this.tool('nginx',['-t'],signal);await guard();await this.tool('nginx',['-s','reload'],signal);
  }
  async publicReady(m,signal){
    for(let i=0;i<3;i++){
      const response=await this.tool('curl',['--disable','--fail','--silent','--include','--max-time','5',`${this.config.publicOrigin}/api/ready`],signal,6000);
      need(response.split(/\r?\n/).some(line=>line.toLowerCase()===`x-siteflow-slot: ${this.slot}`),'PUBLIC_SLOT_MISMATCH');
      need(JSON.parse(response.split(/\r?\n\r?\n/).slice(1).join('\n\n')).ok===true,'PUBLIC_NOT_READY');
    }
  }
  async prepareDecision(){this.save('DECIDING');}
  async commit(m){this.write(path.join(this.root,'current.json'),JSON.stringify({slot:this.slot,port:this.port,container:this.name,image:`${IMAGE_REPOSITORY}@${m.digest}`,sha:m.sha}));this.save('COMMITTED');}
  async retainCandidate(m){this.write(path.join(this.root,'candidate.json'),JSON.stringify({status:'CANDIDATE_READY',releaseId:m.releaseId,name:this.name,slot:this.slot,port:this.port,sha:m.sha,digest:m.digest,migrationDigest:m.migrationDigest,schemaHash:m.schemaHash}));this.save('CANDIDATE_READY');}
  async interrupt(){/* execute() terminates and waits for interrupted clients. Docker daemon state is reconciled separately. */}
  async reconcile(){
    // Never remove legacy, existing 3001, adopted candidates, or an uncertain run.
    if(this.created&&!this.adopted){need(fs.readFileSync(this.config.upstreamFile,'utf8').trim()===this.before.trim(),'ROUTE_UNCERTAIN_KEEP_CONTAINER');await this.tool('docker',['stop','--time','10',this.name]);}
  }
  async rollback(){
    await this.markIncident('ROLLBACK_IN_PROGRESS');
    need(this.before?.trim()===route(this.old.slot).trim(),'ROLLBACK_RECORD_INVALID');
    this.write(this.config.upstreamFile,this.before);await this.tool('nginx',['-t']);await this.tool('nginx',['-s','reload']);
    const status=await this.tool('curl',['--disable','--fail','--silent','--output','/dev/null','--max-time','5','--write-out','%{http_code}',this.config.publicOrigin]);need(status==='200','ROLLBACK_HTTPS_FAILED');
    this.write(path.join(this.root,'current.json'),JSON.stringify(this.old));await this.markIncident('ROLLED_BACK_KEEP_CONTAINERS');this.save('ROLLED_BACK');
  }
}
