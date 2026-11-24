import { need, validateManifest, validateSnapshot, assertAction, assertImage } from './contract.mjs';
import { finalStatus, resolveDecision } from './decision.mjs';

// Adapters are explicit dependencies. The live entry binds the real verifier;
// local tests supply network-free ledger/driver/cryptographic fixtures.
export async function runRelease({ manifest:m, bytes, bundle, policy, verifier, ledger, driver, now, pollMs=5000 }) {
  let locked=false, claimed=false, switched=false, deciding=false, committed=false, finished=false, timer, busy=false, firstError, acceptedDeadline;
  const controller=new AbortController();
  const check=async()=>{
    if(firstError) throw firstError;
    need(!controller.signal.aborted,'RELEASE_ABORTED');
    need(acceptedDeadline===undefined||now()<acceptedDeadline,'LOCAL_LEASE_EXPIRED');
    validateManifest(m,now(),policy);
    const snapshot=await ledger.snapshot(m);
    // A delayed response/renewal cannot revive a deadline already accepted by
    // this process. A restart cannot retry because USED is retained.
    need(acceptedDeadline===undefined||now()<acceptedDeadline,'LOCAL_LEASE_EXPIRED');
    validateSnapshot(m,snapshot,now());
    acceptedDeadline=Math.max(acceptedDeadline??0,snapshot.lease.expiresAt);
  };
  const watch=async()=>{ if(busy||finished||deciding)return;busy=true;try{await check();}catch(e){firstError=e;controller.abort();}finally{busy=false;} };
  const finalize=async()=>{if(m.mode==='publish')await driver.commit(m);else await driver.retainCandidate(m);await ledger.state(m.releaseId,`LOCAL_${finalStatus(m)}`);return {status:finalStatus(m)};};
  try {
    validateManifest(m,now(),policy);
    need(bytes===JSON.stringify(m),'MANIFEST_BYTES_MISMATCH');
    await verifier(bytes,bundle,m,policy);
    await check();
    await driver.lock();locked=true;
    await driver.preflight(m);
    await ledger.claim(m,now());claimed=true;
    timer=setInterval(()=>{void watch();},pollMs);
    await check();
    assertAction(m.mode,'pull');const images=await driver.pull(m,controller.signal);
    await check();assertImage(m,images.image,images.migration,images.receipt);
    assertAction(m.mode,'candidate');await driver.stage(m,controller.signal);
    await check();assertAction(m.mode,'ready');await driver.ready(m,controller.signal);
    await check();
    if(m.mode==='publish') {
      assertAction(m.mode,'nginx-switch'); switched=true;
      await driver.switchRoute(m,controller.signal,check);
      await check();assertAction(m.mode,'nginx-reload');await driver.publicReady(m,controller.signal);
      assertAction(m.mode,'commit');
    }
    await driver.prepareDecision(m);await check();
    deciding=true;clearInterval(timer);
    // Sole commit point: conditional on STOP, generation, lease, USED, no ABORT.
    await ledger.finish(m,now());committed=true;
    return await finalize();
  } catch(e) {
    controller.abort();
    if(timer)clearInterval(timer);
    // Stop and reconcile managed work before rollback. Do not delete a possibly
    // published candidate or stop legacy containers. Rollback never needs a lease.
    let recovery='ABORTED';
    if(locked) {
      try{await driver.markIncident(deciding?'DECISION_REVIEW_REQUIRED':'RECOVERY_REQUIRED');}
      catch{driver.holdLock();return {status:'INCIDENT_WRITE_FAILED'};}
      if(deciding&&!committed){
        try{committed=(await resolveDecision(ledger,m)).outcome==='COMMITTED';}
        catch{driver.holdLock();return {status:'COMMIT_UNKNOWN'};}
      }
      if(committed){
        try{return await finalize();}
        catch{driver.holdLock();return {status:'LOCAL_FINALIZATION_FAILED'};}
      }
      try { await driver.interrupt(); if(switched){await driver.rollback();recovery='ROLLED_BACK';}else await driver.reconcile(); }
      catch { recovery='ROLLBACK_FAILED';driver.holdLock(); }
    }
    if(claimed)try{await ledger.state(m.releaseId,recovery);}catch{/* no false success when AWS is unreachable */}
    return {status:recovery,reason:/^[A-Z][A-Z0-9_]{0,80}$/.test(e?.message??'')?e.message:'RELEASE_FAILED'};
  } finally {
    finished=true;if(timer)clearInterval(timer);
    if(locked)await driver.unlock();
  }
}
