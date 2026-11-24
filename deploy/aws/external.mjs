import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { need, REGION, INSTANCE } from './contract.mjs';

export function liveConfig(config) {
  need(config.liveEnabled === true && /^[0-9]{12}$/.test(config.accountId) && config.region === REGION && config.instanceId === INSTANCE && /^[A-Za-z0-9_-]{3,64}$/.test(config.table), 'LIVE_CONFIGURATION_DISABLED');
  need(/^[0-9]+$/.test(config.policy?.repositoryId) && ['signerSha','implementationSha'].every(k=>/^[a-f0-9]{40}$/.test(config.policy?.[k]??'')&&!/^0+$/.test(config.policy[k])), 'TRUST_NOT_CONFIGURED');
  return config;
}
export function readConfig(file) { return liveConfig(JSON.parse(fs.readFileSync(file,'utf8'))); }
export function processEnvironment(mode, source = {}) {
  const env={ PATH:source.PATH??'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', AWS_REGION:REGION, AWS_DEFAULT_REGION:REGION, AWS_PAGER:'', AWS_CONFIG_FILE:'/dev/null', AWS_SHARED_CREDENTIALS_FILE:'/dev/null', AWS_MAX_ATTEMPTS:'1' };
  // No ambient PAT, GH token, proxy, Docker auth, BASH_ENV, or debug settings.
  if(mode==='actions')for(const k of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN']){need(typeof source[k]==='string'&&source[k].length>0,'SHORT_SESSION_REQUIRED');env[k]=source[k];}
  if(mode==='cloudshell')for(const k of ['AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONTAINER_AUTHORIZATION_TOKEN'])if(source[k])env[k]=source[k];
  return env;
}
export function execute(file,args,{env,signal,timeout=15000,maxBytes=1048576,ssmVisibilityError=false,input}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{env,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    let output='', diagnostic='', bytes=0, done=false, failed=false, killTimer;
    const kill=()=>{if(failed||done)return;failed=true;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill();}catch{/* child already ended */}killTimer=setTimeout(()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* ended */}},1000);};
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',kill);if(error)reject(new Error(error));else resolve(value);};
    const timer=setTimeout(kill,timeout);
    if(input!==undefined){child.stdin.on('error',kill);child.stdin.end(input);}
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>maxBytes)kill();else output+=data.toString('utf8');});
    child.stderr.on('data',data=>{if(ssmVisibilityError&&diagnostic.length<2048)diagnostic+=data.toString('utf8').slice(0,2048-diagnostic.length);}); // Never expose raw errors.
    child.on('error',()=>finish('EXTERNAL_TOOL_UNAVAILABLE'));
    child.on('close',code=>finish(failed?'OPERATION_INTERRUPTED':code===0?null:ssmVisibilityError&&/\(InvocationDoesNotExist\)/.test(diagnostic)?'INVOCATION_NOT_VISIBLE':'EXTERNAL_OPERATION_FAILED',output));
    if(signal?.aborted)kill();else signal?.addEventListener('abort',kill,{once:true});
  });
}
export class AwsClient {
  constructor(config,mode,source={}){this.config=liveConfig(config);this.env=processEnvironment(mode,source);}
  async call(service,operation,input,signal){
    // Input contains only public release metadata; never credentials.
    const out=await execute('aws',['--region',REGION,'--no-cli-pager',service,operation,'--cli-input-json','file:///dev/stdin','--output','json'],{env:this.env,signal,input:JSON.stringify(input),timeout:5000,ssmVisibilityError:service==='ssm'&&operation==='get-command-invocation'});
    try{return out.trim()?JSON.parse(out):{};}catch{throw new Error('INVALID_AWS_RESPONSE');}
  }
  async identity(){const d=await this.call('sts','get-caller-identity',{});need(d.Account===this.config.accountId,'WRONG_AWS_ACCOUNT');return d;}
}
