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
    if (!chunks || !chunks.length) {
      logger.warn(`No chunks`, { docId });
      await markDocExtracted(docId);
      return;
    }

    logger.info(`${chunks.length} chunks to process`, { docId });

    const allEntities      = [];
    const allRelationships = [];

    for (let i=0; i<chunks.length; i++) {
      const chunk = chunks[i];
      const { entities, relationships } = await extractFromChunk(chunk, doc);

      allEntities.push(...entities);
      allRelationships.push(...relationships);

      if ((i+1) % 5 === 0 || i === chunks.length-1) {
        logger.info(`${i+1}/${chunks.length} chunks — ${allEntities.length} entities, ${allRelationships.length} rels`, { docId });
      }

      if (CHUNK_DELAY > 0) await sleep(CHUNK_DELAY);
    }

    // שמור ישויות וקבל IDs
    const savedEntities = allEntities.length > 0
      ? await saveEntities(allEntities)
      : [];

    // שמור קשרים עם IDs
    if (allRelationships.length > 0 && savedEntities.length > 0) {
      await saveRelationships(allRelationships, savedEntities);
    }

    await markDocExtracted(docId);

    // סיכום
    const summary = {};
    allEntities.forEach(e => { summary[e.entity_type] = (summary[e.entity_type]||0)+1; });
    const secs = ((Date.now()-t0)/1000).toFixed(1);
    logger.info(`✅ DONE in ${secs}s | entities: ${JSON.stringify(summary)} | rels: ${allRelationships.length}`, { docId });

  } catch (err) {
    logger.error(`❌ FAILED: ${err.message}`, { docId });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
