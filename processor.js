import logger from './logger.js';
import { getDocChunks, saveEntities, saveRelationships, markDocExtracted } from './supabase.js';
import { extractFromChunk } from './extractor.js';

const CHUNK_DELAY = parseInt(process.env.CHUNK_DELAY_MS) || 500;

export async function processDocument(doc) {
  const docId = doc.id;
  logger.info(`━━ START "${doc.title}" ━━`, { docId });
  const t0 = Date.now();
  try {
    const chunks = await getDocChunks(docId);
    if (!chunks?.length) {
      logger.warn(`No chunks`, { docId });
      await markDocExtracted(docId);
      return;
    }
    logger.info(`${chunks.length} chunks`, { docId });

    const allEntities = [], allRels = [];

    for (let i=0; i<chunks.length; i++) {
      const { entities, relationships } = await extractFromChunk(chunks[i], doc);
      allEntities.push(...entities);
      allRels.push(...relationships);
      if ((i+1) % 5 === 0) logger.info(`${i+1}/${chunks.length} chunks — ${allEntities.length} entities`, { docId });
      if (CHUNK_DELAY > 0) await sleep(CHUNK_DELAY);
    }

    const savedEntities = allEntities.length ? await saveEntities(allEntities) : [];
    if (allRels.length && savedEntities.length) await saveRelationships(allRels, savedEntities);
    await markDocExtracted(docId);

    const summary = {};
    allEntities.forEach(e => { summary[e.entity_type] = (summary[e.entity_type]||0)+1; });
    logger.info(`✅ DONE in ${((Date.now()-t0)/1000).toFixed(1)}s | ${JSON.stringify(summary)} | rels:${allRels.length}`, { docId });

  } catch(err) {
    logger.error(`❌ FAILED: ${err.message}`, { docId });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
