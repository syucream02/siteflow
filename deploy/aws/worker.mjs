import { pathToFileURL } from 'node:url';
import { readConfig, AwsClient } from './external.mjs';
import { AwsLedger } from './ledger.mjs';
import { releaseId, need } from './contract.mjs';
import { createOfflineVerifier } from './verify-attestation.mjs';
import { ReleaseDriver, privateFile } from './driver.mjs';
import { recoverRelease } from './recovery.mjs';
import { runRelease } from './engine.mjs';

export async function main(args){
  need(args.length===3&&['run','recover'].includes(args[0]),'USAGE_WORKER_MODE_CONFIG_RELEASE');
  const [mode,file,id]=args;releaseId(id);
  need(process.platform==='linux'&&process.getuid()===0,'LINUX_ROOT_REQUIRED');privateFile(file);
  const config=readConfig(file);
  const client=new AwsClient(config,'ec2'),ledger=new AwsLedger(client);
  if(mode==='recover'){
    return recoverRelease(new ReleaseDriver(config,{releaseId:id}),ledger);
  }
  await client.identity();
  const grant=await ledger.get(`GRANT#${id}`);need(typeof grant?.manifest==='string','GRANT_REQUIRED');
  const manifest=JSON.parse(grant.manifest);need(manifest.releaseId===id,'GRANT_RELEASE_MISMATCH');
  return runRelease({manifest,bytes:grant.manifest,bundle:grant.bundle,policy:config.policy,verifier:createOfflineVerifier(config.verifier),ledger,driver:new ReleaseDriver(config,manifest),now:()=>Math.floor(Date.now()/1000)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main(process.argv.slice(2)).then(result=>{console.log(JSON.stringify(result));if(!['COMMITTED','CANDIDATE_READY','STALE_RECOVERY_IGNORED','ROLLED_BACK'].includes(result.status))process.exitCode=1;}).catch(()=>{console.error('AWS_RELEASE_REJECTED');process.exitCode=1;});
}
