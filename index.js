import 'dotenv/config';
import cron   from 'node-cron';
import http   from 'http';
import logger from './logger.js';
import { getDocsForExtraction, getStats } from './supabase.js';
import { processDocument }                from './processor.js';

const CRON      = process.env.ENTITY_CRON        || '*/5 * * * *';
const BATCH     = parseInt(process.env.ENTITY_BATCH_LIMIT) || 3;
const AUTO_RUN  = process.env.ENTITY_AUTO_RUN === 'true';

let isRunning = false, tickCount = 0;

process.on('uncaughtException',  e => logger.error(`uncaughtException: ${e.message}`));
process.on('unhandledRejection', e => logger.error(`unhandledRejection: ${e}`));

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type','application/json');
  if (req.method==='GET' && req.url==='/health') {
    const stats = await getStats().catch(()=>({}));
    res.end(JSON.stringify({ status:'ok', isRunning, tickCount, model: process.env.CLAUDE_MODEL, ...stats }));
    return;
  }
  if (req.method==='POST' && req.url==='/run') {
    if (isRunning) { res.statusCode=409; res.end(JSON.stringify({error:'Already running'})); return; }
    logger.info('Manual trigger via /run');
    runBatch().catch(e => logger.error(e.message));
    res.end(JSON.stringify({ ok:true, message:`Starting batch of ${BATCH} docs` }));
    return;
  }
  res.statusCode=404; res.end(JSON.stringify({error:'Not found'}));
});

server.listen(process.env.PORT||3002, () => logger.info(`HTTP on port ${process.env.PORT||3002}`));

async function runBatch() {
  if (isRunning) return;
  isRunning = true; tickCount++;
  try {
    const stats = await getStats();
    logger.info(`📊 extracted:${stats.extracted} pending:${stats.pending}`);
    if (stats.pending === 0) { logger.info('✅ Queue empty'); return; }
    const docs = await getDocsForExtraction(BATCH);
    if (!docs?.length) { logger.info('Nothing to process'); return; }
    logger.info(`Processing ${docs.length} documents`);
    for (const doc of docs) await processDocument(doc);
    logger.info(`Batch done`);
  } catch(err) {
    logger.error(`Batch error: ${err.message}`);
  } finally { isRunning = false; }
}

async function main() {
  logger.info('══════════════════════════════════');
  logger.info('  Entity Worker v1');
  logger.info(`  Model: ${process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'}`);
  logger.info(`  Batch: ${BATCH} | Auto: ${AUTO_RUN?'ON':'OFF'}`);
  logger.info('══════════════════════════════════');

  const missing = ['ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_KEY'].filter(k=>!process.env[k]);
  if (missing.length) { logger.error(`Missing: ${missing.join(', ')}`); process.exit(1); }

  if (AUTO_RUN) {
    await runBatch();
    cron.schedule(CRON, () => runBatch().catch(e => logger.error(e.message)));
  } else {
    logger.info('⚠️  Manual mode — POST /run to start');
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
main().catch(e => { logger.error(e.message); process.exit(1); });
