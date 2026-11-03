import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, utimes, rm, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { buildServer, purgeExpiredOutputs } from '../src/server/index.js';
import { getDb } from '../src/server/db.js';
import { createMagicToken, verifyMagicToken, createSession } from '../src/server/auth.js';

function multipart(buffer: Buffer, fileFirst = true, from = 'ro', to = 'hu') {
  const field = (name: string,value: string) => Buffer.from(`--otter\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const file = Buffer.concat([Buffer.from('--otter\r\nContent-Disposition: form-data; name="file"; filename="sample.docx"\r\nContent-Type: application/octet-stream\r\n\r\n'),buffer,Buffer.from('\r\n')]);
  const fields = Buffer.concat([field('from',from),field('to',to)]);
  return Buffer.concat(fileFirst?[file,fields,Buffer.from('--otter--\r\n')]:[fields,file,Buffer.from('--otter--\r\n')]);
}

test('HTTP product: login, concurrent token redemption, upload ordering/limits, ownership, worker, retention and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'otter-http-'));
  process.env.DB_PATH=path.join(dir,'app.db'); process.env.OUTPUT_DIR=path.join(dir,'files');
  process.env.EMAIL_ALLOWLIST=' Alice@Example.com , bob@example.com'; process.env.TRANSLATION_BACKEND='identity';
  const links: string[]=[];
  let server=await buildServer({logger:false,worker:false,sendMagicLink:async(_,link)=>{links.push(link);}});
  try {
    const app=server.app;
    assert.equal((await app.inject('/')).statusCode,200);
    assert.match((await app.inject('/')).body,/Send sign-in link/);
    assert.equal((await app.inject({method:'POST',url:'/api/upload'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/auth/request',payload:{email:' ALICE@example.com '}})).statusCode,200);
    assert.equal(links.length,1);
    const url=new URL(links[0]);
    const results=await Promise.all([app.inject(url.pathname+url.search),app.inject(url.pathname+url.search)]);
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[302,401]);
    const header=results.find(r=>r.statusCode===302)!.headers['set-cookie'] as string;
    assert.match(header,/Path=\//); assert.match(header,/Max-Age=2592000/); assert.match(header,/HttpOnly/); assert.match(header,/SameSite=Lax/);
    const cookie=header.split(';')[0];
    assert.match((await app.inject({url:'/',headers:{cookie}})).body,/Translate a document/);
    const fixture=await readFile(new URL('./fixtures/hyperlink.docx',import.meta.url));
    const upload=(buffer=fixture, first=true) => app.inject({method:'POST',url:'/api/upload',headers:{cookie,'content-type':'multipart/form-data; boundary=otter'},payload:multipart(buffer,first)});
    assert.equal((await upload(Buffer.from('PK\x03\x04garbage'))).statusCode,400);
    assert.equal((await upload(Buffer.alloc(2*1024*1024+1))).statusCode,413);
    const invalid=new AdmZip();invalid.addFile('[Content_Types].xml',Buffer.from('<Types/>'));invalid.addFile('word/document.xml',Buffer.from('<broken>'));
    assert.equal((await upload(invalid.toBuffer())).statusCode,400);
    const first=await upload(); assert.equal(first.statusCode,202,first.body);
    const second=await upload(fixture,false); assert.equal(second.statusCode,202,second.body);
    assert.equal((await upload()).statusCode,429);
    const job=await getDb().get<any>('SELECT * FROM jobs WHERE id=?',[first.json().id]);assert.equal(job.from_lang,'ro');assert.equal(job.to_lang,'hu');
    assert.equal((await app.inject({url:'/api/jobs',headers:{cookie}})).json().length,2);
    const bob=await verifyMagicToken(await createMagicToken('bob@example.com')); const bobCookie='session='+await createSession(bob!.id);
    assert.equal((await app.inject({url:'/api/jobs/'+job.id,headers:{cookie:bobCookie}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie,origin:'https://evil.example'}})).statusCode,403);
    await server.jobQueue.start();
    let done:any;
    for(let i=0;i<100;i++) { done=(await app.inject({url:'/api/jobs/'+job.id,headers:{cookie}})).json();if(done.status==='done')break;await new Promise(r=>setTimeout(r,25)); }
    assert.equal(done.status,'done');assert.equal(done.progress,100);
    const download=await app.inject({url:'/api/download/'+job.id,headers:{cookie}});assert.equal(download.statusCode,200);
    assert.match(new AdmZip(download.rawPayload).readAsText('word/document.xml'),/hyperlink/);
    await server.jobQueue.stop();
    await getDb().run("UPDATE jobs SET status='running' WHERE id=?",[second.json().id]);
    await server.close();
    server=await buildServer({logger:false});
    assert.equal((await getDb().get<any>('SELECT * FROM jobs WHERE id=?',[second.json().id])).stage,'interrupted');
    await server.jobQueue.stop();
    await getDb().run("UPDATE jobs SET created_at='2000-01-01T00:00:00Z'");
    const orphan='11111111-1111-1111-1111-111111111111.docx';await writeFile(path.join(dir,'files',orphan),'orphan');await utimes(path.join(dir,'files',orphan),new Date(0),new Date(0));
    assert.equal(await purgeExpiredOutputs(),2);
    assert.deepEqual(await readdir(path.join(dir,'files')),[]);
    const token=await createMagicToken('alice@example.com');const redemptions=await Promise.all(Array.from({length:8},()=>verifyMagicToken(token)));assert.equal(redemptions.filter(Boolean).length,1);
  } finally { await server.close();await rm(dir,{recursive:true,force:true}); }
});

test('SMTP unavailable returns an actionable error and invalidates the undelivered token', async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'otter-smtp-'));process.env.DB_PATH=path.join(dir,'app.db');process.env.OUTPUT_DIR=path.join(dir,'files');process.env.EMAIL_ALLOWLIST='alice@example.com';
 const s=await buildServer({logger:false,worker:false,sendMagicLink:async()=>{throw new Error('offline');}});
 try {const r=await s.app.inject({method:'POST',url:'/api/auth/request',payload:{email:'alice@example.com'}});assert.equal(r.statusCode,503);assert.equal((await getDb().all('SELECT * FROM magic_tokens')).length,0);}finally{await s.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTPS cookies, daily admission, concurrent limits and retention deletion failures',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'otter-limits-'));
 Object.assign(process.env,{DB_PATH:path.join(dir,'app.db'),OUTPUT_DIR:path.join(dir,'files'),ORIGIN:'https://otter.example.com',EMAIL_ALLOWLIST:'alice@example.com'});
 let link='';const server=await buildServer({logger:false,worker:false,sendMagicLink:async(_,value)=>{link=value;}});
 try {
  await server.app.inject({method:'POST',url:'/api/auth/request',payload:{email:'alice@example.com'}});
  const verify=await server.app.inject(new URL(link).pathname+new URL(link).search);
  const header=verify.headers['set-cookie'] as string;assert.match(header,/Secure/);const cookie=header.split(';')[0];
  const fixture=await readFile(new URL('./fixtures/plain-paragraph.docx',import.meta.url));
  const upload=()=>server.app.inject({method:'POST',url:'/api/upload',headers:{cookie,'content-type':'multipart/form-data; boundary=otter'},payload:multipart(fixture)});
  const concurrent=await Promise.all(Array.from({length:5},upload));assert.equal(concurrent.filter(r=>r.statusCode===202).length,2);assert.equal(concurrent.filter(r=>r.statusCode===429).length,3);
  await getDb().run("UPDATE jobs SET status='failed'");
  const user=await getDb().get<any>('SELECT * FROM users');
  for(let i=0;i<8;i++)await getDb().run("INSERT INTO jobs (id,user_id,input_filename,from_lang,to_lang,status,created_at) VALUES (?,?,?,'en','ro','failed',?)",['day-'+i,user.id,'missing-'+i,new Date().toISOString()]);
  assert.equal((await upload()).statusCode,429);
  // Treat a filesystem deletion failure as retryable; do not remove the row.
  const blocker=path.join(dir,'files','blocked-input.docx');await import('node:fs/promises').then(fs=>fs.mkdir(blocker));
  await getDb().run("INSERT INTO jobs(id,user_id,input_filename,from_lang,to_lang,status,created_at) VALUES('blocked',?,?,'en','ro','failed','2000-01-01')",[user.id,'blocked-input.docx']);
  const cleanupErrors: unknown[] = [];
  assert.equal(await purgeExpiredOutputs(undefined, error => { cleanupErrors.push(error); }), 0);assert.equal(cleanupErrors.length, 1);assert.ok(await getDb().get("SELECT * FROM jobs WHERE id='blocked'"));
  await rm(blocker,{recursive:true});assert.equal(await purgeExpiredOutputs(),1);
  assert.equal((await server.app.inject({url:'/api/jobs/blocked',headers:{cookie}})).statusCode,404);
 }finally{await server.close();delete process.env.ORIGIN;await rm(dir,{recursive:true,force:true});}
});

test('worker shutdown aborts in-flight work and waits for its database update',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'otter-stop-'));Object.assign(process.env,{DB_PATH:path.join(dir,'app.db'),OUTPUT_DIR:path.join(dir,'files'),EMAIL_ALLOWLIST:'alice@example.com'});
 const server=await buildServer({logger:false,worker:false});
 try{
  const user=await verifyMagicToken(await createMagicToken('alice@example.com'));
  await writeFile(path.join(dir,'files','input.docx'),'test');
  await getDb().run("INSERT INTO jobs(id,user_id,input_filename,from_lang,to_lang) VALUES('active',?,'input.docx','en','ro')",[user!.id]);
  const {JobQueue}=await import('../src/server/queue.js');
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const queue=new JobQueue(server.quotaStore,path.join(dir,'files'),async(_buffer,options)=>{
   options.onStage?.('translating',50);entered();
   return new Promise((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  });
  await queue.start();await started;await queue.stop();
  const job=await getDb().get<any>("SELECT * FROM jobs WHERE id='active'");assert.equal(job.status,'failed');assert.match(job.error_message,/interrupted/);assert.equal(job.progress,50);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
