import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { releaseId } from './contract.mjs';
import { privateFile } from './driver.mjs';
export function publicResult(id,record,incident){
  releaseId(id);
  const statuses=['COMMITTED','CANDIDATE_READY','ROLLED_BACK','RUNNING','SWITCHING','DECIDING'];
  return {releaseId:id,status:record?.releaseId===id&&statuses.includes(record.status)?record.status:'UNKNOWN',reviewRequired:incident===true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const id=releaseId(process.argv[2]),root='/srv/siteflow-mysql/release-aws';
    const file=`${root}/${id}.json`;
    const result=publicResult(id,fs.existsSync(file)?JSON.parse(privateFile(file)):undefined,fs.existsSync(`${root}/incident.json`));
    console.log(JSON.stringify(result));
    if(result.reviewRequired||!['COMMITTED','CANDIDATE_READY','ROLLED_BACK'].includes(result.status))process.exitCode=1;
  }catch{console.error('RESULT_UNAVAILABLE');process.exitCode=1;}
}
