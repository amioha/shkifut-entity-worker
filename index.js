import 'dotenv/config';
import cron   from 'node-cron';
import http   from 'http';
import logger from './logger.js';
import { getDocsForExtraction, getStats } from './supabase.js';
import { processDocument }                from './processor.js';

const CRON         = process.env.ENTITY_CRON        || '*/5 * * * *';
const BATCH        = parseInt(process.env.ENTITY_BATCH_LIMIT) || 3;
const AUTO_RUN     = process.env.ENTITY_AUTO_RUN === 'true'; // ברירת מחדל: כבוי!
let isRunning   = false;
let tickCount   = 0;

process.on('uncaughtException',  e => logger.error(`uncaughtException: ${e.message}`));
process.on('unhandledRejection', e => logger.error(`unhandledRejection: ${e}`));

/* =============================================
   HTTP — health + manual trigger
============================================= */
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    const stats = await getStats().catch(() => ({}));
    res.end(JSON.stringify({ status:'ok', isRunning, tickCount, ...stats }));
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    if (isRunning) { res.statusCode=409; res.end(JSON.stringify({error:'Already running'})); return; }
    logger.info('Manual trigger via /run');
    runBatch().catch(e => logger.error(`Manual run: ${e.message}`));
    res.end(JSON.stringify({ ok:true, message:'Entity extraction started' }));
    return;
  }

  res.statusCode=404; res.end(JSON.stringify({error:'Not found'}));
});

server.listen(process.env.PORT || 3002, () => {
  logger.info(`HTTP on port ${process.env.PORT || 3002}`);
});

/* =============================================
   MAIN BATCH
============================================= */
async function runBatch() {
  if (isRunning) return;
  isRunning = true;
  tickCount++;

  try {
    const stats = await getStats();
    logger.info(`📊 Entities — extracted:${stats.extracted} pending:${stats.pending}`);

    if (stats.pending === 0) {
      logger.info('✅ All documents extracted — queue empty');
      return;
    }

    const docs = await getDocsForExtraction(BATCH);
    if (!docs || docs.length === 0) { logger.info('Queue empty'); return; }

    logger.info(`Processing ${docs.length} documents this batch`);
    for (const doc of docs) {
      await processDocument(doc);
    }
    logger.info(`Batch done: ${docs.length} documents`);

  } catch (err) {
    logger.error(`Batch error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/* =============================================
   STARTUP
============================================= */
async function main() {
  logger.info('══════════════════════════════════════');
  logger.info('  שקיפות נתיבות — Entity Worker v1');
  logger.info(`  Model: ${process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'}`);
  logger.info(`  Batch: ${BATCH} docs | Auto: ${AUTO_RUN ? 'ON' : 'OFF (manual only)'}`);
  logger.info('══════════════════════════════════════');

  const required = ['ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { logger.error(`Missing: ${missing.join(', ')}`); process.exit(1); }

  // לא מריץ אוטומטית בהפעלה — רק דרך /run
  if (AUTO_RUN) {
    logger.info('Auto mode ON — running immediately and scheduling cron');
    await runBatch();
    cron.schedule(CRON, () => runBatch().catch(e => logger.error(e.message)));
  } else {
    logger.info('⚠️  Manual mode — waiting for POST /run to start');
    logger.info('   Send POST to /run when ready');
  }
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

main().catch(e => { logger.error(e.message); process.exit(1); });
