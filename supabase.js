import axios  from 'axios';
import logger from './logger.js';

const BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY  = process.env.SUPABASE_KEY;
const H    = {
  apikey:        KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type':'application/json',
  Prefer:        'return=representation',
};

async function req(method, path, params={}, body=null) {
  try {
    const res = await axios({ method, url:`${BASE}/rest/v1/${path}`,
      headers:H, params, data:body, timeout:20_000 });
    return res.data;
  } catch(err) {
    logger.error(`Supabase ${method} ${path}: ${err.response?.data?.message||err.message}`);
    throw err;
  }
}

export async function getDocsForExtraction(limit=10) {
  // שאילתה ישירה — מסמכים עם chunks שלא עברו extraction
  const docs = await req('GET','nv_documents',{
    select:             'id,title,year,doc_type',
    status:             'eq.done',
    entities_extracted: 'is.null',
    order:              'id.asc',
    limit:              limit * 5, // שלוף יותר כי חלקם אולי בלי chunks
  });

  if (!docs || !docs.length) return [];

  // בדוק אילו מהם יש להם chunks
  const docIds = docs.map(d => d.id);
  const chunks = await req('GET','nv_chunks',{
    select:      'document_id',
    document_id: `in.(${docIds.join(',')})`,
    limit:       1000,
  });

  const idsWithChunks = new Set((chunks||[]).map(c => c.document_id));

  // מסמכים בלי chunks — סמן אותם כ-extracted כדי לא לנסות שוב
  const withoutChunks = docs.filter(d => !idsWithChunks.has(d.id));
  if (withoutChunks.length > 0) {
    logger.info(`Marking ${withoutChunks.length} docs without chunks as extracted`);
    for (const doc of withoutChunks) {
      await req('PATCH','nv_documents',{id:`eq.${doc.id}`},{
        entities_extracted: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  // החזר רק מסמכים עם chunks
  return docs.filter(d => idsWithChunks.has(d.id)).slice(0, limit);
}

export async function getDocChunks(docId) {
  return req('GET','nv_chunks',{
    select:      'id,content,page_num,chunk_index',  // page_num ולא page_number
    document_id: `eq.${docId}`,
    order:       'chunk_index.asc',
  });
}

export async function saveEntities(entities) {
  if (!entities.length) return [];
  const BATCH = 100;
  let saved = [];
  for (let i=0; i<entities.length; i+=BATCH) {
    try {
      const res = await req('POST','nv_entities',{},entities.slice(i,i+BATCH));
      saved = saved.concat(res || []);
    } catch(e) {
      logger.warn(`saveEntities batch ${i} failed: ${e.message}`);
    }
  }
  return saved;
}

export async function saveRelationships(rels, savedEntities) {
  if (!rels.length || !savedEntities.length) return;
  const entityMap = {};
  savedEntities.forEach(e => {
    if (e.value_norm && !entityMap[e.value_norm]) entityMap[e.value_norm] = e.id;
  });
  const relsWithIds = rels.map(r => {
    const aId = entityMap[r.entity_a_norm];
    const bId = entityMap[r.entity_b_norm];
    if (!aId || !bId) return null;
    return {
      doc_id:        r.doc_id,
      chunk_id:      r.chunk_id,
      entity_a_id:   aId,
      entity_b_id:   bId,
      relation_type: r.relation_type,
      context:       r.context,
    };
  }).filter(Boolean);
  if (!relsWithIds.length) return;
  try {
    await req('POST','nv_relationships',{},relsWithIds);
    logger.debug(`Saved ${relsWithIds.length} relationships`);
  } catch(e) {
    logger.warn(`saveRelationships failed: ${e.message}`);
  }
}

export async function markDocExtracted(docId) {
  return req('PATCH','nv_documents',{id:`eq.${docId}`},{
    entities_extracted: new Date().toISOString(),
  });
}

export async function getStats() {
  try {
    const [extracted, pending] = await Promise.all([
      req('GET','nv_documents',{select:'id',status:'eq.done',entities_extracted:'not.is.null'}),
      req('GET','nv_documents',{select:'id',status:'eq.done',entities_extracted:'is.null'}),
    ]);
    return { extracted:(extracted||[]).length, pending:(pending||[]).length };
  } catch { return { extracted:0, pending:0 }; }
}
