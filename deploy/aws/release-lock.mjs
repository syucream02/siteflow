import fs from 'node:fs';
import path from 'node:path';
import { need, releaseId } from './contract.mjs';

export function processAlive(pid) {
  need(Number.isInteger(pid) && pid > 0, 'INVALID_LOCK_OWNER');
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
// No automatic removal of a foreign/stale lock in the normal release path.
export class ReleaseLock {
  constructor(root, id, {read, write, alive=processAlive, pid=process.pid}) {
    this.root=root;this.id=releaseId(id);this.read=read;this.write=write;this.alive=alive;this.pid=pid;
    this.directory=path.join(root,'lock');this.active=path.join(root,'active.json');this.owner=path.join(this.directory,'owner.json');
  }
  activeRecord(){return fs.existsSync(this.active)?JSON.parse(this.read(this.active)):undefined;}
  acquire(recovery=false){
    const active=this.activeRecord();
    if(recovery)need(active?.releaseId===this.id,'RECOVERY_NOT_ACTIVE');else need(!active,'UNRESOLVED_ACTIVE_RELEASE');
    if(recovery&&fs.existsSync(this.directory)){
      const owner=JSON.parse(this.read(this.owner));
      need(owner.releaseId===this.id&&!this.alive(owner.pid),'RECOVERY_OWNER_ALIVE_OR_DIFFERENT');
      fs.mkdirSync(path.join(this.directory,'recovery'),{mode:0o700});this.recovery=true;
    }else fs.mkdirSync(this.directory,{mode:0o700});
    this.write(this.owner,JSON.stringify({releaseId:this.id,pid:this.pid}));
    if(!recovery)this.write(this.active,JSON.stringify({releaseId:this.id}));
    this.held=true;
  }
  hold(){this.sticky=true;}
  release(){
    if(!this.held||this.sticky)return;
    const owner=JSON.parse(this.read(this.owner));
    need(owner.releaseId===this.id&&owner.pid===this.pid&&this.activeRecord()?.releaseId===this.id,'LOCK_OWNERSHIP_CHANGED');
    fs.unlinkSync(this.active);
    if(this.recovery)fs.rmdirSync(path.join(this.directory,'recovery'));
    fs.unlinkSync(this.owner);fs.rmdirSync(this.directory);this.held=false;
  }
}
