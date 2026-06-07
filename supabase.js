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

export async function getDocsForExtraction(limit=3) {
  return req('GET','nv_documents',{
    select:               'id,title,year,doc_type',
    status:               'eq.done',
    entities_extracted:   'is.null',
    order:                'id.asc',
    limit,
  });
}

export async function getDocChunks(docId) {
  return req('GET','nv_chunks',{
    select:      'id,content,page_number,chunk_index',
    document_id: `eq.${docId}`,
    order:       'chunk_index.asc',
  });
}

// שמור ישויות — מחזיר עם IDs
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

// שמור קשרים — עם entity IDs מה-DB
export async function saveRelationships(rels, savedEntities) {
  if (!rels.length || !savedEntities.length) return;

  // בנה מפה: value_norm → entity_id
  const entityMap = {};
  savedEntities.forEach(e => {
    if (!entityMap[e.value_norm]) entityMap[e.value_norm] = e.id;
  });

  // הוסף IDs לקשרים
  const relsWithIds = rels
    .map(r => {
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
    })
    .filter(Boolean);

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
    const [extracted, pending, totalEntities] = await Promise.all([
      req('GET','nv_documents',{select:'id',status:'eq.done','entities_extracted':'not.is.null'}),
      req('GET','nv_documents',{select:'id',status:'eq.done','entities_extracted':'is.null'}),
      req('GET','nv_entities',{select:'id',limit:1}),
    ]);
    return {
      extracted:      (extracted||[]).length,
      pending:        (pending||[]).length,
      total_entities: 'check Supabase',
    };
  } catch { return { extracted:0, pending:0 }; }
}
