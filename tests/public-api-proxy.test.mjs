import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyPublicApi } from '../lib/siteflow/public-api-proxy.ts';
import { publicResponseCookie } from '../lib/siteflow/public-cookies.ts';
const origin='https://demo.example.com';const team='10000000-0000-4000-8000-000000000001';
const forbidden=async()=>{throw Error('must not fetch');};
const config={enabled:true,publicOrigin:origin,backendOrigin:'http://127.0.0.1:5175',fetcher:forbidden};
const request=(path,options={})=>new Request(`${origin}/api/siteflow/${path}`,{...options,headers:{Host:'demo.example.com',...options.headers}});
const post=(body={},headers={})=>({method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const run=(path,options={},extra={})=>proxyPublicApi(request(path,options),path.split('?')[0].split('/'),{...config,...extra});
const cookie='__Secure-better-auth.session_token=opaque; Path=/; HttpOnly; Secure; SameSite=Lax';

test('明示有効化と固定HTTPS Originがなければ接続しない',async()=>{
  for(const enabled of [false,undefined])assert.equal((await run('teams',{}, {enabled})).status,404);
  for(const publicOrigin of [undefined,'http://demo.example.com','https://127.0.0.1','https://demo.local','https://user:private@demo.example.com','https://demo.example.com/path','https://demo.example.com?token=private'])assert.equal((await run('teams',{}, {publicOrigin})).status,503);
});
test('Hostや転送ヘッダーの偽装、異なるOriginの更新を拒否する',async()=>{
  for(const Host of ['', 'evil.example.com','demo.example.com:444'])assert.equal((await run('teams',{headers:{Host,'X-Forwarded-Host':'demo.example.com','X-Forwarded-Proto':'https'}})).status,403);
  for(const Origin of ['', 'https://evil.example.com','null'])assert.equal((await run('auth/sign-out',post({}, {Origin}))).status,403);
  assert.equal((await run('teams',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await proxyPublicApi(new Request('http://evil.example.com/api/siteflow/teams',{headers:{Host:'demo.example.com'}}),['teams'],config)).status,403);
});
test('Next内部がloopbackのHTTPでも公開Hostを検査し、内部APIへ固定Originを渡す',async()=>{
  const response=await proxyPublicApi(new Request('http://localhost:3000/api/siteflow/auth/sign-out',post({}, {Host:'demo.example.com','X-Forwarded-For':'spoof','X-Role':'admin'})),['auth','sign-out'],{...config,fetcher:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:5175/api/auth/sign-out');assert.equal(options.headers.has('host'),false);assert.equal(options.headers.get('origin'),origin);assert.equal(options.headers.has('x-forwarded-for'),false);assert.equal(options.headers.has('x-role'),false);assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');return Response.json({success:true});
  }});assert.equal(response.status,200);
  const internalHttps=await proxyPublicApi(new Request('https://127.0.0.1:3000/api/siteflow/teams',{headers:{Host:'demo.example.com'}}),['teams'],{...config,fetcher:async()=>Response.json({items:[]})});assert.equal(internalHttps.status,200);
});
test('許可経路/操作、JSON/本文上限、loopback接続先の制限を共通に保つ',async()=>{
  assert.equal((await run('auth/sign-up/email',post())).status,404);
  assert.equal((await run('teams',{method:'DELETE'})).status,405);
  assert.equal((await run('auth/sign-in/email',{...post(),body:'{'})).status,400);
  assert.equal((await run('auth/sign-in/email',post({}, {'Content-Type':'text/plain'}))).status,415);
  assert.equal((await run('auth/sign-in/email',post({password:'x'.repeat(4097)}))).status,413);
  assert.equal((await run(`teams/${team}/projects`,post({notes:'x'.repeat(32769)}))).status,413);
  for(const backendOrigin of [undefined,'http://evil.example.com:5175','http://127.0.0.1:5175/path'])assert.equal((await run('teams',{}, {backendOrigin})).status,503);
});
test('認証Cookieだけを送り、重複した認証Cookieは送信前に拒否する',async()=>{
  const name='__Secure-better-auth.session_token';
  const response=await run('teams',{headers:{Cookie:`analytics=private; session=unrelated; ${name}=opaque; __Host-better-auth.extra=other`}}, {fetcher:async(url,options)=>{assert.equal(options.headers.get('cookie'),`${name}=opaque; __Host-better-auth.extra=other`);return Response.json({items:[]});}});assert.equal(response.status,200);
  assert.equal((await run('teams',{headers:{Cookie:`${name}=one; ${name}=two`}})).status,400);
  const noCookies=await run('teams',{headers:{Cookie:'unrelated=private'}},{fetcher:async(url,options)=>{assert.equal(options.headers.has('cookie'),false);return Response.json({items:[]});}});assert.equal(noCookies.status,200);
});
test('Secure/HttpOnly/SameSiteを保ち、複数Cookieと削除のPathを揃える',async()=>{
  const headers=new Headers();headers.append('Set-Cookie',cookie);headers.append('Set-Cookie','__Secure-better-auth.dont_remember=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax');
  const response=await run('auth/sign-in/email',post(),{fetcher:async()=>Response.json({token:'do-not-return'},{headers})});
  assert.deepEqual(await response.json(),{ok:true});const cookies=response.headers.getSetCookie();assert.equal(cookies.length,2);for(const value of cookies){assert.match(value,/Path=\/api\/siteflow/);assert.match(value,/HttpOnly/);assert.match(value,/Secure/);assert.match(value,/SameSite=Lax/);}assert.match(cookies[1],/Max-Age=0/);assert.match(cookies[1],/Expires=Thu, 01 Jan 1970/);
});
test('__Host-CookieのPathはルートのまま保ち、Domainや条件違反を拒否する',()=>{
  const hostCookie=cookie.replace('__Secure-','__Host-');assert.equal(publicResponseCookie(hostCookie),hostCookie);
  assert.throws(()=>publicResponseCookie(hostCookie.replace('Path=/;','Path=/api/siteflow;')));
  for(const value of [cookie+'; Domain=demo.example.com',cookie.replace('Secure; ',''),cookie.replace('HttpOnly; ',''),cookie.replace('Lax','None'),cookie+'; Path=/',cookie.replace('Path=/;','Path=/other;'),cookie.replace('__Secure-better-auth.','unknown.'),cookie+'; Max-Age=invalid'])assert.throws(()=>publicResponseCookie(value));
});
test('不正な上流Cookieでは一部だけ返さず、秘密値を出さない503にする',async()=>{
  const headers=new Headers();headers.append('Set-Cookie',cookie);headers.append('Set-Cookie','private=DO_NOT_EXPOSE; Path=/');
  const response=await run('auth/sign-out',post(),{fetcher:async()=>Response.json({success:true},{headers})});assert.equal(response.status,503);assert.equal(response.headers.getSetCookie().length,0);assert.ok(!(await response.text()).includes('DO_NOT_EXPOSE'));
});
test('セッション応答の秘密値を除き、利用者表示だけを返す',async()=>{
  const response=await run('auth/get-session',{}, {fetcher:async()=>Response.json({user:{id:'u',name:'架空',email:'fiction@example.invalid',private:'omit'},session:{token:'omit'}})});assert.deepEqual(await response.json(),{user:{id:'u',name:'架空',email:'fiction@example.invalid'}});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('vary'),'Cookie');
});
test('接続障害や上流失敗を秘密値なしのエラーにする',async()=>{
  for(const fetcher of [async()=>{throw Error('PRIVATE_DETAIL');},async()=>Response.json({secret:'PRIVATE_DETAIL'},{status:500}),async()=>new Response('PRIVATE_DETAIL')]){const response=await run('teams',{}, {fetcher});assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATE_DETAIL'));}
});
