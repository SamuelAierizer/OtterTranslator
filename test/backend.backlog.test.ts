import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicrosoftTranslatorBackend } from '../src/engine/backends/ms-translator.ts';
import { GoogleCloudTranslationBackend } from '../src/engine/backends/google-cloud.ts';
import { createBackend } from '../src/engine/backends/index.ts';
import { normalizeTranslation } from '../src/engine/tags.ts';

test('F19 transient 429 retries Microsoft without spending Google quota', async () => {
 const saved = fetch; const hosts: string[] = [];
 globalThis.fetch = (async (url, init) => { hosts.push(String(url)); if (hosts.length === 1) return new Response('{}', {status:429, headers:{'Retry-After':'0'}}); return Response.json(JSON.parse(String(init!.body)).map(() => ({translations:[{text:'translated'}]}))); }) as typeof fetch;
 try { assert.deepEqual(await createBackend('composite',{msKey:'ms',gcKey:'gc'}).translateBatch(['source'], 'en','hu'), ['translated']); assert.equal(hosts.length,2); assert.ok(hosts.every(h => h.includes('microsofttranslator'))); } finally { globalThis.fetch = saved; }
});
for (const [name, Backend] of [['Microsoft', MicrosoftTranslatorBackend], ['Google', GoogleCloudTranslationBackend]] as const) {
 test(`F20 ${name} packs texts into one aligned request`, async () => {
 const saved=fetch; let calls=0;
 globalThis.fetch = (async (_url, init) => { calls++; const body = JSON.parse(String(init!.body)); const texts = Array.isArray(body) ? body.map(x => x.text) : body.q;
 assert.ok(Array.isArray(texts)); return Response.json(name === 'Microsoft' ? texts.map((t:string) => ({translations:[{text:t+'!'}]})) : {data:{translations:texts.map((t:string) => ({translatedText:t+'!'}))}}); }) as typeof fetch;
 try { assert.deepEqual(await new Backend('key').translateBatch(['one','two','three'], 'en','hu'), ['one!','two!','three!']); assert.equal(calls,1); } finally {globalThis.fetch=saved;}
 });
}
test('F11/F12 repair marker spacing and preserve intended break whitespace', () => {
 assert.equal(normalizeTranslation('a[br/]b', 'a [br /] b'), 'a[br/]b');
 assert.equal(normalizeTranslation('a [br/] b', 'a [br /] b'), 'a [br/] b');
});

test('F15 long paragraph splitting never bisects tags or Unicode characters', async () => {
 const { splitTaggedText } = await import('../src/engine/backends/batching.ts');
 const source = 'a'.repeat(29998) + '[f123]😀word[/f123]' + 'b'.repeat(31000);
 const chunks = splitTaggedText(source, 30000);
 assert.equal(chunks.join(''), source);
 assert.ok(chunks.every(c => c.length <= 30000));
 for (const c of chunks) { assert.equal(c.replace(/\[(?:\/?f\d+)\]/g,'').includes('['), false); assert.equal(c.isWellFormed(), true); }
});
test('F21 every sliding minute stays under the character budget, including queued calls', async () => {
 const { CharacterRateLimiter } = await import('../src/engine/rate-limit.ts');
 let time=0; const seen: Array<{at:number; chars:number}> = [];
 const limiter = new CharacterRateLimiter(33000, 60000, () => time, async ms => { time += ms; });
 await Promise.all(Array.from({length:100}, async () => { await limiter.acquire(2000); seen.push({at:time,chars:2000}); }));
 for (const event of seen) assert.ok(seen.filter(e => e.at > event.at - 60000 && e.at <= event.at).reduce((n,e) => n+e.chars,0) <= 33000);
});
test('F19 Retry-After supports seconds and HTTP dates', async () => {
 const { retryDelay } = await import('../src/engine/backends/request.ts');
 assert.equal(retryDelay('3',0),3000); assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:05 GMT',0,1000),4000);
});
for (const [name, Backend] of [['Microsoft', MicrosoftTranslatorBackend], ['Google', GoogleCloudTranslationBackend]] as const) {
 test(`F12 ${name} repairs provider marker spacing before validation`, async () => {
 const saved=fetch;
 globalThis.fetch = (async () => Response.json(name === 'Microsoft' ? [{translations:[{text:'[ f1 ]a [br /] b[ / f1 ]'}]}] : {data:{translations:[{translatedText:'[ f1 ]a [br /] b[ / f1 ]'}]}})) as typeof fetch;
 try { assert.deepEqual(await new Backend('key').translateBatch(['[f1]a[br/]b[/f1]'],'en','hu'),['[f1]a[br/]b[/f1]']); } finally {globalThis.fetch=saved;}
 });
 test(`${name} rejects a short provider response without shifting paragraphs`, async () => {
 const saved=fetch;
 globalThis.fetch = (async () => Response.json(name === 'Microsoft' ? [{translations:[{text:'one'}]}] : {data:{translations:[{translatedText:'one'}]}})) as typeof fetch;
 try { await assert.rejects(() => new Backend('key').translateBatch(['one','two'],'en','hu'), /incomplete translation/); } finally {globalThis.fetch=saved;}
 });
}
test('F19 sustained rate limits never route to Google and every retry keeps its reservation', async () => {
 const { InMemoryQuotaStore, currentMonth } = await import('../src/engine/quota.ts');
 const saved=fetch; const quota = new InMemoryQuotaStore(); let calls=0;
 globalThis.fetch = (async url => {calls++; assert.ok(String(url).includes('microsofttranslator')); return new Response('{}',{status:429,headers:{'Retry-After':'0'}});}) as typeof fetch;
 try { await assert.rejects(() => createBackend('composite',{msKey:'ms',gcKey:'gc',quota}).translateBatch(['one'],'en','hu'), /three attempts/); assert.equal(calls,3); assert.equal(await quota.getUsage('microsoft-translator',currentMonth()),9); assert.equal(await quota.getUsage('google-cloud',currentMonth()),0); } finally {globalThis.fetch=saved;}
});
test('F19 unrelated authorization errors do not spend Google quota', async () => {
 const saved=fetch; let calls=0;
 globalThis.fetch = (async () => {calls++; return Response.json({error:{code:403000,message:'Not authorized'}},{status:403});}) as typeof fetch;
 try {await assert.rejects(() => createBackend('composite',{msKey:'ms',gcKey:'gc'}).translateBatch(['one'],'en','hu'), /403/); assert.equal(calls,1);} finally {globalThis.fetch=saved;}
});
