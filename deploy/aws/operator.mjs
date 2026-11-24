import { pathToFileURL } from 'node:url';
import { readConfig, AwsClient } from './external.mjs';
import { AwsLedger } from './ledger.mjs';
import { need, releaseId } from './contract.mjs';
export async function main(args){
  need(args.length>=3&&args.length<=4&&['stop','resume'].includes(args[0])&&args[2]==='CONFIRM-SITEFLOW-PRODUCTION','EXPLICIT_OPERATOR_CONFIRMATION_REQUIRED');
  const [mode,file,,id]=args;
  if(id!==undefined||mode==='resume')releaseId(id);
  const config=readConfig(file),client=new AwsClient(config,'cloudshell',process.env);const identity=await client.identity();
  need(typeof config.operatorArnPrefix==='string'&&identity.Arn?.startsWith(config.operatorArnPrefix),'OPERATOR_IDENTITY_NOT_APPROVED');
  const ledger=new AwsLedger(client),control=await ledger.get('CONTROL#production');need(control,'CONTROL_REQUIRED');
  if(mode==='stop'){
    await ledger.stop(control.epoch,identity.Arn);console.log('STOP_REQUEST_ACCEPTED_NEW_STARTS_BLOCKED');
    if(!id){console.log('EC2_COMPLETION_NOT_CONFIRMED');return;}
    releaseId(id);
    for(let i=0;i<18;i++){
      const s=await ledger.get(`FINAL#${id}`)??await ledger.get(`STATE#${id}`);
      if(['ABORTED','ROLLED_BACK'].includes(s?.status)){console.log(s.status);return;}
      if(s?.status==='ROLLBACK_FAILED')throw new Error('RECOVERY_REQUIRED');
      if(['COMMITTED','CANDIDATE_READY'].includes(s?.status)){console.log('FINAL_DECIDED_CHECK_LOCAL_ACK_AND_INCIDENT_SEPARATE_ROLLBACK_APPROVAL_REQUIRED');return;}
      await new Promise(resolve=>setTimeout(resolve,5000));
    }throw new Error('EC2_COMPLETION_NOT_CONFIRMED');
  }
  releaseId(id);const final=await ledger.get(`FINAL#${id}`),previous=await ledger.get(`STATE#${id}`);
  need(final?['COMMITTED','CANDIDATE_READY'].includes(final.status)&&previous?.status===`LOCAL_${final.status}`:['ABORTED','ROLLED_BACK'].includes(previous?.status),'RECOVERY_NOT_CONFIRMED');
  await ledger.resume(control.epoch,Math.floor(Date.now()/1000));console.log('NEW_EPOCH_OPEN_FRESH_RUN_AND_APPROVAL_REQUIRED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(()=>{console.error('OPERATOR_ACTION_NOT_CONFIRMED');process.exitCode=1;});
