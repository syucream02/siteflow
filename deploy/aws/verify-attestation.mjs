import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execute, processEnvironment } from './external.mjs';
import { hash, need, REPOSITORY, SIGNER_WORKFLOW } from './contract.mjs';

export function trustedFile(file,expectedHash){
  need(path.isAbsolute(file)&&/^[a-f0-9]{64}$/.test(expectedHash),'TRUST_FILE_NOT_PINNED');
  const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o022)===0,'UNTRUSTED_VERIFIER_FILE');
  if(process.platform==='linux')need(s.uid===0,'VERIFIER_NOT_ROOT_OWNED');
  need(hash(fs.readFileSync(file))===expectedHash,'TRUST_FILE_HASH_MISMATCH');
}
export function createOfflineVerifier(config){
  return async(bytes,bundle,m,policy)=>{
    trustedFile(config.ghPath,config.ghSha256);trustedFile(config.trustedRootPath,config.trustedRootSha256);
    need(Number.isSafeInteger(config.trustedRootReviewedAt)&&Math.floor(Date.now()/1000)-config.trustedRootReviewedAt<=30*86400&&config.trustedRootReviewedAt<=Math.floor(Date.now()/1000),'TRUST_ROOT_REVIEW_EXPIRED');
    need(typeof bundle==='string'&&Buffer.byteLength(bundle)<=131072&&Buffer.byteLength(bytes)<=16384,'ATTESTATION_TOO_LARGE');
    const dir=fs.mkdtempSync(path.join(config.verificationDirectory??os.tmpdir(),'siteflow-attest-'));
    try{
      const subject=path.join(dir,'release.json'),proof=path.join(dir,'bundle.jsonl');
      fs.writeFileSync(subject,bytes,{mode:0o600,flag:'wx'});fs.writeFileSync(proof,bundle,{mode:0o600,flag:'wx'});
      const env={...processEnvironment('offline'),HOME:dir,GH_CONFIG_DIR:dir,GH_PROMPT_DISABLED:'1'};
      need(process.platform==='linux'&&process.getuid()===0,'OFFLINE_LINUX_ROOT_REQUIRED');
      // No interfaces/routes from the host: unexpected online fallback must fail.
      const out=await execute('/usr/bin/unshare',['--net',config.ghPath,'attestation','verify',subject,'--bundle',proof,'--custom-trusted-root',config.trustedRootPath,'--repo',REPOSITORY,'--signer-workflow',`${REPOSITORY}/${SIGNER_WORKFLOW}`,'--signer-digest',policy.signerSha,'--source-ref','refs/heads/main','--deny-self-hosted-runners','--format','json'],{env,timeout:20000});
      const results=JSON.parse(out);
      need(Array.isArray(results)&&results.length===1&&String(results[0]?.verificationResult?.signature?.certificate?.sourceRepositoryIdentifier)===m.repositoryId,'ATTESTATION_IDENTITY_MISMATCH');
    }finally{
      // Only these two locally generated nonsecret files are removed.
      for(const name of ['release.json','bundle.jsonl']){const p=path.join(dir,name);if(fs.existsSync(p))fs.unlinkSync(p);}fs.rmdirSync(dir);
    }
  };
}
