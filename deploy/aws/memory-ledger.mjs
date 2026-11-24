// Network-free protocol fixture. Production entry points never import this file.
import { copy, hash, need, validateSnapshot } from './contract.mjs';
import { finalStatus } from './decision.mjs';
export class MemoryLedger {
  #items = new Map();
  #offline = false;
  constructor(epoch = 1, notBefore = 0) { this.#items.set('CONTROL#production', { epoch, notBefore }); }
  offline(value) { this.#offline = value; }
  verifyIdentity(){this.get('CONTROL#production');}
  get(key) { need(!this.#offline, 'LEDGER_UNAVAILABLE'); return copy(this.#items.get(key)); }
  putAs(role,key,item) {
    const allow = { issuer: /^(GRANT|LEASE)#/, worker: /^(USED|STATE|FINAL|ABORT)#/, stopper: /^STOP#/, maintainer: /^CONTROL#production$/ };
    need(allow[role]?.test(key), 'IAM_WRITE_DENIED');
    if (key.startsWith('USED#')) need(!this.#items.has(key), 'ALREADY_USED');
    this.#items.set(key, copy(item));
  }
  issue(m, now, bundle = 'fixture') {
    const control = this.get('CONTROL#production');
    need(control.epoch === m.epoch && m.runCreatedAt >= control.notBefore && !this.get(`STOP#${m.epoch}`), 'ISSUE_STOPPED');
    need(!this.get(`GRANT#${m.releaseId}`), 'GRANT_ALREADY_EXISTS');
    this.putAs('issuer',`GRANT#${m.releaseId}`, { manifest: JSON.stringify(m), manifestHash: hash(JSON.stringify(m)), bundle });
    this.renew(m,now);
  }
  renew(m,now) {
    const old=this.get(`LEASE#${m.releaseId}`), control=this.get('CONTROL#production');
    need(!this.get(`STOP#${m.epoch}`) && control.epoch===m.epoch && now<m.expiresAt && (!old || old.expiresAt>now), 'LEASE_CANNOT_REVIVE');
    this.putAs('issuer',`LEASE#${m.releaseId}`, { releaseId:m.releaseId, epoch:m.epoch, manifestHash:hash(JSON.stringify(m)), updatedAt:now, expiresAt:Math.min(now+30,m.expiresAt) });
  }
  snapshot(m) { return { control:this.get('CONTROL#production'),stop:this.get(`STOP#${m.epoch}`),grant:this.get(`GRANT#${m.releaseId}`),lease:this.get(`LEASE#${m.releaseId}`) }; }
  claim(m,now) { validateSnapshot(m,this.snapshot(m),now); this.putAs('worker',`USED#${m.releaseId}`,{manifestHash:hash(JSON.stringify(m)),claimedAt:now}); }
  finish(m,now){validateSnapshot(m,this.snapshot(m),now);need(this.get(`USED#${m.releaseId}`)?.manifestHash===hash(JSON.stringify(m)),'USED_REQUIRED');need(!this.get(`ABORT#${m.releaseId}`)&&!this.get(`FINAL#${m.releaseId}`),'DECISION_ALREADY_MADE');this.putAs('worker',`FINAL#${m.releaseId}`,{manifestHash:hash(JSON.stringify(m)),status:finalStatus(m)});}
  fence(m){need(!this.get(`FINAL#${m.releaseId}`)&&!this.get(`ABORT#${m.releaseId}`),'DECISION_ALREADY_MADE');this.putAs('worker',`ABORT#${m.releaseId}`,{manifestHash:hash(JSON.stringify(m))});}
  stop(epoch) { need(this.get('CONTROL#production').epoch===epoch,'CONTROL_CHANGED');this.putAs('stopper',`STOP#${epoch}`,{stopped:true}); }
  resume(now) { const c=this.get('CONTROL#production');need(this.get(`STOP#${c.epoch}`),'STOP_BEFORE_RESUME');this.putAs('maintainer','CONTROL#production',{epoch:c.epoch+1,notBefore:now}); }
  state(id,status) { this.putAs('worker',`STATE#${id}`,{status}); }
}
