import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
const server=https.createServer({key:fs.readFileSync('/run/tls/key.pem'),cert:fs.readFileSync('/run/tls/fullchain.pem'),minVersion:'TLSv1.2'},(req,res)=>{
  if(!['13.237.188.172','13.237.188.172:443'].includes(req.headers.host??'')){res.writeHead(421);res.end();return;}
  const upstream=http.request({hostname:'127.0.0.1',port:3001,path:req.url,method:req.method,headers:{...req.headers,host:'13.237.188.172','x-forwarded-proto':'https','x-forwarded-host':'13.237.188.172'}},reply=>{res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('error',()=>upstream.destroy());req.pipe(upstream);
});
server.listen(3443,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
