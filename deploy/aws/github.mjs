import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, processEnvironment } from './external.mjs';
import { need, REPOSITORY, hash, validateProtectionReview } from './contract.mjs';

// Actions-only adapter. Never imported by the EC2 entry point.
export class GitHubReader {
  constructor(token){need(typeof token==='string'&&token.length>0,'ACTIONS_TOKEN_REQUIRED');this.token=token;}
  async request(route,raw=false){
    need(/^(git\/ref\/heads\/main|actions\/runs\/\d+(\/jobs\?filter=latest&per_page=100|\/approvals|\/artifacts\?per_page=100)?|actions\/workflows\/ci.yml\/runs\?branch=main&event=push&per_page=30|actions\/artifacts\/\d+\/zip|environments\/production(\/deployment-branch-policies)?)$/.test(route),'GITHUB_ROUTE_DENIED');
    let response;try{response=await fetch(`https://api.github.com/repos/${REPOSITORY}/${route}`,{headers:{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'manual',signal:AbortSignal.timeout(5000)});}catch{throw new Error('GITHUB_UNAVAILABLE');}
    if(raw)return response;
    need(response.status===200,'GITHUB_READ_REJECTED');return response.json();
  }
  async evidence(m,images,policy){
    const review=validateProtectionReview(m,policy,Math.floor(Date.now()/1000));
    const [main,ci,own,history,environment,branches,latest]=await Promise.all([
      this.request('git/ref/heads/main'),this.request(`actions/runs/${m.ciRunId}`),this.request(`actions/runs/${m.deployRunId}`),this.request(`actions/runs/${m.deployRunId}/approvals`),this.request('environments/production'),this.request('environments/production/deployment-branch-policies'),this.request('actions/workflows/ci.yml/runs?branch=main&event=push&per_page=30')
    ]);
    const last=latest.workflow_runs?.filter(r=>r.head_sha===m.sha).sort((a,b)=>b.id-a.id)[0];need(String(last?.id)===m.ciRunId&&last.run_attempt===m.ciAttempt,'LATEST_CI_REQUIRED');
    need(own.status==='in_progress'&&own.event==='workflow_dispatch','DEPLOYMENT_NOT_ACTIVE');
    const rules=environment.protection_rules?.filter(r=>r.type==='required_reviewers');
    need(rules?.length===1&&rules[0].prevent_self_review===false,'REVIEW_PROTECTION_REQUIRED');
    const approvalRecords=history.flatMap(a=>(a.environments??[]).filter(e=>e.id===environment.id&&e.name==='production').map(()=>({environment:'production',state:a.state,user:a.user?.login})));
    return {
      mainSha:main.object?.sha,
      ci:{repository:ci.repository?.full_name,id:String(ci.id),attempt:ci.run_attempt,event:ci.event,branch:ci.head_branch,workflow:ci.path,sha:ci.head_sha,status:ci.status,conclusion:ci.conclusion},
      deployment:{id:String(own.id),repository:own.repository?.full_name,ref:`refs/heads/${own.head_branch}`,attempt:own.run_attempt,createdAt:Math.floor(Date.parse(own.created_at)/1000),signerSha:m.signerSha},
      approvals:approvalRecords,
      protection:{reviewers:rules[0].reviewers.map(r=>r.type==='User'?r.reviewer.login:'INVALID'),bypass:!review.bypassDisabled,bypassReviewHash:hash(JSON.stringify(review)),mainOnly:environment.deployment_branch_policy?.custom_branch_policies===true&&environment.deployment_branch_policy?.protected_branches===false&&branches.total_count===1&&branches.branch_policies?.length===1&&branches.branch_policies[0].name==='main'&&(branches.branch_policies[0].type??'branch')==='branch'},images
    };
  }
  async images(ciId,attempt,sha){
    const list=await this.request(`actions/runs/${ciId}/artifacts?per_page=100`);
    const artifacts=list.artifacts?.filter(a=>a.name===`ci-images-${sha}-${ciId}-${attempt}`&&!a.expired);
    need(artifacts?.length===1,'CI_IMAGE_ARTIFACT_REQUIRED');
    const redirect=await this.request(`actions/artifacts/${artifacts[0].id}/zip`,true);
    need(redirect.status===302,'ARTIFACT_REDIRECT_REQUIRED');
    const url=new URL(redirect.headers.get('location'));
    need(url.protocol==='https:'&&url.hostname.endsWith('.blob.core.windows.net')&&!url.username&&!url.password,'ARTIFACT_HOST_NOT_APPROVED');
    // New request: the GitHub Authorization header is NOT forwarded.
    const result=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});need(result.ok,'ARTIFACT_DOWNLOAD_FAILED');
    const reader=result.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;need(size<=131072,'ARTIFACT_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel();}
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siteflow-ci-'));
    try{const archive=path.join(dir,'record.zip');fs.writeFileSync(archive,Buffer.concat(chunks),{flag:'wx',mode:0o600});const out=await execute('unzip',['-p',archive,'ci-images.json'],{env:processEnvironment('offline'),maxBytes:16384});const record=JSON.parse(out);need(record.sha===sha&&record.ciRunId===ciId&&record.ciAttempt===attempt,'CI_RECORD_IDENTITY_MISMATCH');return record;}
    finally{const archive=path.join(dir,'record.zip');if(fs.existsSync(archive))fs.unlinkSync(archive);fs.rmdirSync(dir);}
  }
}
