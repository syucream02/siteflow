import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AwsClient, readConfig } from './external.mjs';
import { AwsLedger } from './ledger.mjs';
import { GitHubReader } from './github.mjs';
import { checkFinal } from './decision.mjs';
import { need, hash, verifyImplementation, validateManifest, verifyAdmission, REPOSITORY, SIGNER_WORKFLOW, INSTANCE } from './contract.mjs';

export async function main(args){
  const e=process.env;
  need(e.GITHUB_ACTIONS==='true'&&e.GITHUB_REPOSITORY===REPOSITORY&&e.GITHUB_REF==='refs/heads/main'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_RUN_ATTEMPT==='1'&&e.SITEFLOW_RELEASE_ENABLED==='true','APPROVED_ACTIONS_CONTEXT_REQUIRED');
  need(args.length===2&&['plan','send'].includes(args[0]),'USAGE_PUBLISH_MODE_CONFIG');
  const config=readConfig(args[1]),client=new AwsClient(config,'actions',e),ledger=new AwsLedger(client),github=new GitHubReader(e.GH_TOKEN);
  verifyImplementation(e.SITEFLOW_IMPLEMENTATION_SHA,config.policy.implementationSha);
  await client.identity();
  if(args[0]==='plan'){
    need(/^[1-9][0-9]{0,19}$/.test(e.SITEFLOW_CI_RUN_ID??''),'CI_RUN_REQUIRED');
    const ci=await github.request(`actions/runs/${e.SITEFLOW_CI_RUN_ID}`),own=await github.request(`actions/runs/${e.GITHUB_RUN_ID}`),control=await ledger.get('CONTROL#production');
    need(control&&!await ledger.get(`STOP#${control.epoch}`),'AWS_STOPPED');
    const images=await github.images(String(ci.id),ci.run_attempt,ci.head_sha);
    need(/^[a-f0-9]{64}$/.test(config.trustedCiWorkflowHash??'')&&images.workflowHash===config.trustedCiWorkflowHash,'CI_WORKFLOW_NOT_TRUSTED');
    const now=Math.floor(Date.now()/1000),m={version:2,repository:REPOSITORY,repositoryId:config.policy.repositoryId,signerWorkflow:SIGNER_WORKFLOW,signerSha:config.policy.signerSha,implementationSha:config.policy.implementationSha,protectionReviewHash:hash(JSON.stringify(config.policy.manualProtectionReview)),releaseId:`deploy-${e.GITHUB_RUN_ID}-1`,sha:ci.head_sha,digest:images.digest,migrationDigest:images.migrationDigest,schemaHash:images.schemaHash,ciRunId:String(ci.id),ciAttempt:ci.run_attempt,deployRunId:e.GITHUB_RUN_ID,attempt:1,runCreatedAt:Math.floor(Date.parse(own.created_at)/1000),issuedAt:now,expiresAt:now+600,epoch:control.epoch,mode:e.SITEFLOW_OPERATION};
    validateManifest(m,now,config.policy);verifyAdmission(m,await github.evidence(m,images,config.policy));
    fs.writeFileSync('release.json',JSON.stringify(m),{mode:0o600,flag:'wx'});
    return;
  }
  const bytes=fs.readFileSync('release.json','utf8'),m=JSON.parse(bytes),bundle=fs.readFileSync('release.bundle.jsonl','utf8');
  need(m.deployRunId===e.GITHUB_RUN_ID&&m.repository===REPOSITORY&&bytes===JSON.stringify(m),'RUN_RECORD_MISMATCH');
  need(Buffer.byteLength(bundle)<=131072,'ATTESTATION_TOO_LARGE');
  const images={sha:m.sha,digest:m.digest,migrationDigest:m.migrationDigest,schemaHash:m.schemaHash};
  validateManifest(m,Math.floor(Date.now()/1000),config.policy);verifyAdmission(m,await github.evidence(m,images,config.policy));
  need(config.documentName==='SiteFlow-ApprovedRelease'&&/^[1-9][0-9]*$/.test(config.documentVersion)&&/^[a-f0-9]{64}$/.test(config.documentSha256),'SSM_DOCUMENT_NOT_PINNED');
  await ledger.issue(m,Math.floor(Date.now()/1000),bundle);
  const command=await client.call('ssm','send-command',{InstanceIds:[INSTANCE],DocumentName:config.documentName,DocumentVersion:config.documentVersion,DocumentHash:config.documentSha256,DocumentHashType:'Sha256',Parameters:{ReleaseId:[m.releaseId]},TimeoutSeconds:60,MaxConcurrency:'1',MaxErrors:'0',Comment:`SiteFlow ${m.releaseId}`,CloudWatchOutputConfig:{CloudWatchLogGroupName:'/siteflow/release',CloudWatchOutputEnabled:true}});
  need(typeof command.Command?.CommandId==='string','SSM_RECEIPT_REQUIRED');
  let missingInvocation=0;
  while(true){
    validateManifest(m,Math.floor(Date.now()/1000),config.policy);
    verifyAdmission(m,await github.evidence(m,images,config.policy));
    const final=await ledger.get(`FINAL#${m.releaseId}`),state=await ledger.get(`STATE#${m.releaseId}`);
    if(final)checkFinal(m,final);
    if(final&&state?.status===`LOCAL_${final.status}`){
      const invocation=await client.call('ssm','get-command-invocation',{CommandId:command.Command.CommandId,InstanceId:INSTANCE});
      if(invocation.Status==='Success'){console.log('RELEASE_COMPLETED');return;}
      need(!['Failed','Cancelled','TimedOut'].includes(invocation.Status),'LOCAL_COMPLETION_NOT_CONFIRMED');
    }
    need(!['ABORTED','ROLLED_BACK','ROLLBACK_FAILED'].includes(state?.status),'EC2_RELEASE_STOPPED');
    const now=Math.floor(Date.now()/1000);validateManifest(m,now,config.policy);if(!final)await ledger.renew(m,now);
    // SSM is checked independently; its eventual status is not an authorization.
    try{
      const result=await client.call('ssm','get-command-invocation',{CommandId:command.Command.CommandId,InstanceId:INSTANCE});
      need(!['Failed','Cancelled','TimedOut'].includes(result.Status),'SSM_RELEASE_FAILED');
    }catch(e){need(e.message==='INVOCATION_NOT_VISIBLE'&&++missingInvocation<=3,'SSM_STATUS_UNAVAILABLE');}
    await new Promise(resolve=>setTimeout(resolve,10000));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(()=>{console.error('PUBLISH_STOPPED_LEASE_WILL_EXPIRE');process.exitCode=1;});
