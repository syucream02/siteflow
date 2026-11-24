import fs from 'node:fs';
import { need } from './contract.mjs';
import { finalStatus, resolveDecision } from './decision.mjs';

// The same persistent lock and active release ID are used by normal and recovery
// paths. Only the same release may reclaim a dead owner's lock.
export async function recoverRelease(driver,ledger){
  const active=driver.guard.activeRecord();
  if(active?.releaseId!==driver.m.releaseId)return {status:'STALE_RECOVERY_IGNORED'};
  await driver.lock(true);
  try{
    await driver.markIncident('RECOVERY_REVIEW_REQUIRED');
    need(fs.existsSync(driver.journal),'RECOVERY_JOURNAL_MISSING');
    const saved=JSON.parse(driver.read(driver.journal));
    need(saved.releaseId===driver.m.releaseId&&saved.manifest?.releaseId===saved.releaseId,'RECOVERY_RECORD_INVALID');
    driver.m=saved.manifest;
    for(const k of ['old','before','name','port','slot'])driver[k]=saved[k];
    need(['RUNNING','SWITCHING','DECIDING','COMMITTED','CANDIDATE_READY','ROLLED_BACK'].includes(saved.status),'RECOVERY_STATE_INVALID');
    if(saved.status==='ROLLED_BACK')return {status:'ROLLED_BACK'};
    if(['RUNNING','SWITCHING'].includes(saved.status)){
      // WAL proves no FINAL request could have been sent: DECIDING must be
      // fsynced first. Pre-decision rollback stays independent of AWS outages.
      if(saved.status==='SWITCHING'&&driver.m.mode==='publish')await driver.rollback();
      else driver.save('ROLLED_BACK');
      try{await ledger.verifyIdentity();await ledger.state(driver.m.releaseId,'ROLLED_BACK');}catch{/* local recovery remains authoritative; incident retained */}
      return {status:'ROLLED_BACK'};
    }
    await ledger.verifyIdentity();
    // An absent FINAL is sealed with ABORT; a delayed transaction can no longer
    // race a rollback. An unavailable ledger leaves lock+incident intact.
    const decision=await resolveDecision(ledger,driver.m);
    if(decision.outcome==='COMMITTED'){
      need(['DECIDING','COMMITTED','CANDIDATE_READY'].includes(saved.status),'FINAL_PHASE_MISMATCH');
      if(driver.m.mode==='publish')await driver.commit(driver.m);else await driver.retainCandidate(driver.m);
      await ledger.state(driver.m.releaseId,`LOCAL_${finalStatus(driver.m)}`);
      return {status:finalStatus(driver.m)};
    }
    if(['SWITCHING','DECIDING'].includes(saved.status)&&driver.m.mode==='publish')await driver.rollback();
    else {
      // A RUNNING interrupted docker run may have completed in dockerd. Keep
      // uncertain containers, block further releases, require manual review.
      driver.save('ROLLED_BACK');
    }
    await ledger.state(driver.m.releaseId,'ROLLED_BACK');
    return {status:'ROLLED_BACK'};
  }catch{
    driver.holdLock();return {status:'RECOVERY_UNRESOLVED'};
  }finally{await driver.unlock();}
}
