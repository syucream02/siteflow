import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { candidateSettings, checkCandidate } from '../scripts/check-candidate.mjs';

const env = { SITEFLOW_CANDIDATE_CHECK_APPROVED:'yes', SITEFLOW_CANDIDATE_URL:'http://127.0.0.1:3001', SITEFLOW_PUBLIC_ORIGIN:'https://siteflow.test', SITEFLOW_TEST_EMAIL:'fixture@example.invalid', SITEFLOW_TEST_PASSWORD:'fictional-password-long', SITEFLOW_TEST_TEAM_ID:'test-team' };

test('候補検証は承認/loopback/HTTPS Origin/架空アカウントを必須にする', () => {
  assert.equal(candidateSettings(env).write, false);
  for(const change of [{SITEFLOW_CANDIDATE_CHECK_APPROVED:''},{SITEFLOW_CANDIDATE_URL:'http://example.com:3001'},{SITEFLOW_CANDIDATE_URL:'http://127.0.0.1:3001/elsewhere'},{SITEFLOW_PUBLIC_ORIGIN:'http://siteflow.test'},{SITEFLOW_TEST_EMAIL:'real@example.com'},{SITEFLOW_TEST_TEAM_ID:'../other'}]) assert.throws(()=>candidateSettings({...env,...change}));
});

for(const write of [false,true]) test(`候補確認はログイン/取得/失効を確認し、書込は別フラグで制御: ${write}`, async () => {
  let signedOut = false, progress = 0, writes = 0;
  const server = http.createServer(async(req,res)=>{
    assert.equal(req.headers.host,'siteflow.test');
    assert.equal(req.headers.origin,'https://siteflow.test');
    assert.equal(req.headers['x-forwarded-proto'],'https');
    let body='';for await(const chunk of req)body+=chunk;
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/api/ready')return reply(200,{ok:true});
    if(req.url.endsWith('/sign-in/email')){assert.equal(JSON.parse(body).password,env.SITEFLOW_TEST_PASSWORD);res.setHeader('Set-Cookie','__Secure-better-auth.session_token=fixture-secret; Path=/api/siteflow; HttpOnly; Secure; SameSite=Lax');return reply(200,{ok:true});}
    if(req.url.endsWith('/sign-out')){signedOut=true;return reply(200,{success:true});}
    if(!req.headers.cookie||signedOut)return reply(401,{});
    if(req.url.endsWith('/get-session'))return reply(200,{user:{id:'test-user'}});
    if(req.method==='POST'){writes++;return reply(201,{project:{id:'new-project'}});}
    if(req.method==='PATCH'){writes++;const input=JSON.parse(body);assert.equal(input.expectedVersion,1);progress=input.progress;return reply(200,{project:{id:'new-project',progress,version:2}});}
    if(req.url.endsWith('/new-project'))return reply(200,{project:{id:'new-project',progress,version:1}});
    return reply(200,{items:[],page:{hasMore:false,nextCursor:null}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const settings=candidateSettings({...env,SITEFLOW_CANDIDATE_URL:'http://127.0.0.1:'+server.address().port,SITEFLOW_CANDIDATE_WRITE_APPROVED:write?'yes':''});
    const result=await checkCandidate(settings);
    assert.equal(result.passed,true);assert.equal(result.writePerformed,write);
    assert.equal(writes,write?2:0);assert.equal(signedOut,true);
    assert.equal(result.checks.at(-1),'ログアウト / 旧session拒否');
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    assert.ok(!JSON.stringify(result).includes(env.SITEFLOW_TEST_PASSWORD));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('不正なJSONやredirectを成功扱いせず、自動で認証情報を再送しない',async()=>{
  let requests=0;
  const server=http.createServer((_req,res)=>{requests++;res.writeHead(302,{Location:'https://elsewhere.invalid'});res.end('not JSON');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(checkCandidate(candidateSettings({...env,SITEFLOW_CANDIDATE_URL:'http://127.0.0.1:'+server.address().port})));assert.equal(requests,1);}
  finally{await new Promise(resolve=>server.close(resolve));}
});
