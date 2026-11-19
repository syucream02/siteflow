import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaceConnection, workspacePageEnabled, proxyWorkspaceApi } from '../lib/siteflow/workspace-connection.ts';
const origin='https://demo.example.com';
const publicEnv={NODE_ENV:'production',SITEFLOW_WORKSPACE_MODE:'public',SITEFLOW_PUBLIC_ORIGIN:origin,SITEFLOW_PUBLIC_API_ORIGIN:'http://127.0.0.1:5175'};
const forbidden=async()=>{throw Error('must not fetch');};
test('未指定は開発時だけlocal、それ以外はdisabled',()=>{
  assert.deepEqual(readWorkspaceConnection({NODE_ENV:'development'}),{mode:'local'});
  for(const NODE_ENV of ['production','test',undefined])assert.deepEqual(readWorkspaceConnection({NODE_ENV}),{mode:'disabled'});
});
test('無効化を明示でき、不明なモードや本番local指定はinvalidになる',()=>{
  assert.deepEqual(readWorkspaceConnection({NODE_ENV:'development',SITEFLOW_WORKSPACE_MODE:'disabled'}),{mode:'disabled'});
  for(const SITEFLOW_WORKSPACE_MODE of ['','PUBLIC','unknown','local'])assert.deepEqual(readWorkspaceConnection({NODE_ENV:'production',SITEFLOW_WORKSPACE_MODE}),{mode:'invalid'});
});
test('公開用URLと専用内部接続先が両方正しい場合だけpublic',()=>{
  assert.deepEqual(readWorkspaceConnection(publicEnv),{mode:'public',publicOrigin:origin,backendOrigin:'http://127.0.0.1:5175'});
  for(const [key,values]of Object.entries({SITEFLOW_PUBLIC_ORIGIN:[undefined,'http://demo.example.com','https://demo.example.com/path','https://localhost'],SITEFLOW_PUBLIC_API_ORIGIN:[undefined,'http://evil.example.com:5175','https://127.0.0.1:5175','http://127.0.0.1:5175/path']}))for(const value of values)assert.deepEqual(readWorkspaceConnection({...publicEnv,[key]:value,SITEFLOW_LOCAL_API_ORIGIN:'http://127.0.0.1:5175'}),{mode:'invalid'});
});
test('画面は無効/誤設定時に閉じ、publicは正しいHostだけを許可する',()=>{
  for(const mode of ['disabled','invalid'])assert.equal(workspacePageEnabled({mode},'demo.example.com'),false);
  assert.equal(workspacePageEnabled({mode:'local'},'127.0.0.1:5173'),true);
  const connection=readWorkspaceConnection(publicEnv);assert.equal(workspacePageEnabled(connection,'demo.example.com'),true);
  for(const host of [null,'evil.example.com','127.0.0.1:3000','demo.example.com:444'])assert.equal(workspacePageEnabled(connection,host),false);
});
test('無効APIは404、誤設定は503で接続せず、ローカルへ切り替えない',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return forbidden();};const request=new Request(origin+'/api/siteflow/teams',{headers:{Host:'demo.example.com'}});
  assert.equal((await proxyWorkspaceApi(request,['teams'],{NODE_ENV:'production'},fetcher)).status,404);
  assert.equal((await proxyWorkspaceApi(request,['teams'],{...publicEnv,SITEFLOW_PUBLIC_API_ORIGIN:undefined,SITEFLOW_LOCAL_API_ORIGIN:'http://127.0.0.1:5175'},fetcher)).status,503);assert.equal(calls,0);
});
test('publicのAPIは公開用中継でCookieとOriginを検査する',async()=>{
  const request=new Request(origin+'/api/siteflow/auth/sign-out',{method:'POST',headers:{Host:'demo.example.com',Origin:origin,'Content-Type':'application/json'},body:'{}'});
  const response=await proxyWorkspaceApi(request,['auth','sign-out'],publicEnv,async(url,options)=>{assert.equal(url,'http://127.0.0.1:5175/api/auth/sign-out');assert.equal(options.headers.get('origin'),origin);return Response.json({success:true});});assert.equal(response.status,200);
  const wrong=new Request(origin+'/api/siteflow/teams',{headers:{Host:'evil.example.com'}});assert.equal((await proxyWorkspaceApi(wrong,['teams'],publicEnv,forbidden)).status,403);
});
test('開発時の既存local接続を保ち、本番では明示localでも開かない',async()=>{
  const request=new Request('http://127.0.0.1:5173/api/siteflow/teams');const response=await proxyWorkspaceApi(request,['teams'],{NODE_ENV:'development',SITEFLOW_LOCAL_API_ORIGIN:'http://127.0.0.1:5175'},async()=>Response.json({items:[]}));assert.equal(response.status,200);
  assert.equal((await proxyWorkspaceApi(request,['teams'],{NODE_ENV:'production',SITEFLOW_WORKSPACE_MODE:'local',SITEFLOW_LOCAL_API_ORIGIN:'http://127.0.0.1:5175'},forbidden)).status,503);
});
