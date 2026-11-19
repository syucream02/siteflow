import http from 'node:http';
import net from 'node:net';
const server=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
server.on('connect',(req,client,head)=>{
  if(req.url!=='13.237.188.172:443'){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const tunnel=net.connect(34439,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)tunnel.write(head);client.pipe(tunnel);tunnel.pipe(client);});
  tunnel.on('error',()=>client.destroy());client.on('error',()=>tunnel.destroy());client.on('close',()=>tunnel.destroy());
});
server.listen(31289,'127.0.0.1');
