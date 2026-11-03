#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { translateDocx } from './engine/index.js';
import { initDb, closeDb } from './server/db.js';
import { SqliteQuotaStore } from './server/quota.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`OtterTranslator — DOCX translation preserving document structure
Usage: npm start -- input.docx output.docx [--from en] [--to ro] [--backend composite|identity] [--review]

Microsoft Translator primary; Google Cloud fallback on quota/provider blocking.
Configure MS_TRANSLATOR_KEY / MS_TRANSLATOR_REGION, optionally GOOGLE_CLOUD_API_KEY.
--backend identity is an offline formatting check; it does not translate.
--review explicitly enables optional configured LLM providers.
Usage is persisted in DB_PATH (default ./data/app.db), shared with the server.
Server: npm run server (after npm run build)
Old --engine, --ollama, --model and --batch-size options are no longer supported.`);
    return;
  }
  let from = 'en', to = 'ro', backend = 'composite', review = false;
  const files: string[] = [];
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (['--from','--to','--backend'].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg==='--from') from=value; else if(arg==='--to') to=value; else backend=value;
    } else if (arg==='--review') review=true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. Run --help.`);
    else files.push(arg);
  }
  if(files.length!==2) throw new Error('Provide input.docx and output.docx. Run --help.');
  if(!['composite','identity'].includes(backend)) throw new Error('Backend must be composite or identity');
  process.env.DB_PATH ||= './data/app.db';
  await initDb();
  try {
    console.log(`Backend: ${backend}; ${from} → ${to}`);
    const output = await translateDocx(await readFile(files[0]), { from,to,backend,verify:review,quota:new SqliteQuotaStore(), onStage:(stage,percent)=>console.log(`${percent}% ${stage}`),onTagMismatch:()=>console.warn('A paragraph retained its source text to preserve formatting.') });
    await writeFile(files[1],output);
    console.log(`Saved ${files[1]}`);
  } finally { await closeDb(); }
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});
