import { hash, need, validateSnapshot } from './contract.mjs';
import { finalStatus } from './decision.mjs';
export function encode(value){if(value===null)return {NULL:true};if(typeof value==='string')return {S:value};if(typeof value==='number')return {N:String(value)};if(typeof value==='boolean')return {BOOL:value};if(Array.isArray(value))return {L:value.map(encode)};return {M:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]))};}
export function decode(value){if('S'in value)return value.S;if('N'in value)return Number(value.N);if('BOOL'in value)return value.BOOL;if('NULL'in value)return null;if('L'in value)return value.L.map(decode);return Object.fromEntries(Object.entries(value.M).map(([k,v])=>[k,decode(v)]));}
const item=value=>encode(value).M;
export class AwsLedger {
  constructor(client){this.client=client;this.table=client.config.table;}
  async verifyIdentity(){await this.client.identity();}
  async get(key){const d=await this.client.call('dynamodb','get-item',{TableName:this.table,Key:{pk:{S:key}},ConsistentRead:true});return d.Item?decode({M:d.Item}):undefined;}
  async snapshot(m){
    const keys=['CONTROL#production',`STOP#${m.epoch}`,`GRANT#${m.releaseId}`,`LEASE#${m.releaseId}`];
    const d=await this.client.call('dynamodb','transact-get-items',{TransactItems:keys.map(pk=>({Get:{TableName:this.table,Key:{pk:{S:pk}}}}))});
    need(d.Responses?.length===4,'INCOMPLETE_AWS_SNAPSHOT');
    return Object.fromEntries(['control','stop','grant','lease'].map((k,i)=>[k,d.Responses[i].Item?decode({M:d.Responses[i].Item}):undefined]));
  }
  check(key,expression,values={}){return {ConditionCheck:{TableName:this.table,Key:{pk:{S:key}},ConditionExpression:expression,...(Object.keys(values).length?{ExpressionAttributeValues:values}:{})}};}
  async issue(m,now,bundle){
    const payload=JSON.stringify(m), manifestHash=hash(payload);
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[
      this.check('CONTROL#production','epoch = :e AND notBefore <= :r',{':e':encode(m.epoch),':r':encode(m.runCreatedAt)}),this.check(`STOP#${m.epoch}`,'attribute_not_exists(pk)'),
      {Put:{TableName:this.table,Item:item({pk:`GRANT#${m.releaseId}`,manifest:payload,manifestHash,bundle}),ConditionExpression:'attribute_not_exists(pk)'}},
      {Put:{TableName:this.table,Item:item({pk:`LEASE#${m.releaseId}`,releaseId:m.releaseId,manifestHash,epoch:m.epoch,updatedAt:now,expiresAt:Math.min(now+30,m.expiresAt)}),ConditionExpression:'attribute_not_exists(pk)'}}
    ]});
  }
  async renew(m,now){
    need(now<m.expiresAt,'APPROVAL_EXPIRED');
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[this.check('CONTROL#production','epoch = :e',{':e':encode(m.epoch)}),this.check(`STOP#${m.epoch}`,'attribute_not_exists(pk)'),
      {Update:{TableName:this.table,Key:{pk:{S:`LEASE#${m.releaseId}`}},UpdateExpression:'SET updatedAt = :n, expiresAt = :x',ConditionExpression:'expiresAt > :n AND manifestHash = :h AND epoch = :e',ExpressionAttributeValues:{':n':encode(now),':x':encode(Math.min(now+30,m.expiresAt)),':h':encode(hash(JSON.stringify(m))),':e':encode(m.epoch)}}}
    ]});
  }
  async claim(m,now){
    validateSnapshot(m,await this.snapshot(m),now);
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[this.check('CONTROL#production','epoch = :e AND notBefore <= :r',{':e':encode(m.epoch),':r':encode(m.runCreatedAt)}),this.check(`STOP#${m.epoch}`,'attribute_not_exists(pk)'),this.check(`GRANT#${m.releaseId}`,'manifestHash = :h',{':h':encode(hash(JSON.stringify(m)))}),this.check(`LEASE#${m.releaseId}`,'expiresAt > :n AND manifestHash = :h',{':n':encode(now),':h':encode(hash(JSON.stringify(m)))}),
      {Put:{TableName:this.table,Item:item({pk:`USED#${m.releaseId}`,manifestHash:hash(JSON.stringify(m)),claimedAt:now}),ConditionExpression:'attribute_not_exists(pk)'}}]});
  }
  async finish(m,now){
    validateSnapshot(m,await this.snapshot(m),now);
    const manifestHash=hash(JSON.stringify(m));
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[
      this.check('CONTROL#production','epoch = :e AND notBefore <= :r',{':e':encode(m.epoch),':r':encode(m.runCreatedAt)}),
      this.check(`STOP#${m.epoch}`,'attribute_not_exists(pk)'),this.check(`ABORT#${m.releaseId}`,'attribute_not_exists(pk)'),
      this.check(`LEASE#${m.releaseId}`,'expiresAt > :n AND manifestHash = :h AND epoch = :e',{':n':encode(now),':h':encode(manifestHash),':e':encode(m.epoch)}),
      this.check(`GRANT#${m.releaseId}`,'manifestHash = :h',{':h':encode(manifestHash)}),this.check(`USED#${m.releaseId}`,'manifestHash = :h',{':h':encode(manifestHash)}),
      {Put:{TableName:this.table,Item:item({pk:`FINAL#${m.releaseId}`,manifestHash,status:finalStatus(m)}),ConditionExpression:'attribute_not_exists(pk)'}}
    ]});
  }
  async fence(m){
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[this.check(`FINAL#${m.releaseId}`,'attribute_not_exists(pk)'),
      {Put:{TableName:this.table,Item:item({pk:`ABORT#${m.releaseId}`,manifestHash:hash(JSON.stringify(m))}),ConditionExpression:'attribute_not_exists(pk)'}}]});
  }
  async state(id,status){need(!['COMMITTED','CANDIDATE_READY'].includes(status),'USE_CONDITIONAL_FINISH');await this.client.call('dynamodb','put-item',{TableName:this.table,Item:item({pk:`STATE#${id}`,status})});}
  async stop(epoch,operator){
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[this.check('CONTROL#production','epoch = :e',{':e':encode(epoch)}),{Put:{TableName:this.table,Item:item({pk:`STOP#${epoch}`,operator,stoppedAt:Math.floor(Date.now()/1000)})}}]});
    need(await this.get(`STOP#${epoch}`),'STOP_READBACK_FAILED');
  }
  async resume(epoch,now){
    await this.client.call('dynamodb','transact-write-items',{TransactItems:[this.check(`STOP#${epoch}`,'attribute_exists(pk)'),{Update:{TableName:this.table,Key:{pk:{S:'CONTROL#production'}},UpdateExpression:'SET epoch = :next, notBefore = :n',ConditionExpression:'epoch = :old',ExpressionAttributeValues:{':next':encode(epoch+1),':old':encode(epoch),':n':encode(now)}}}]});
  }
}
