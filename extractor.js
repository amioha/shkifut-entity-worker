import axios  from 'axios';
import logger from './logger.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

export async function extractFromChunk(chunk, docMeta) {
  const prompt = `אתה מומחה לחילוץ מידע ממסמכים ממשלתיים ועירוניים בישראל.

חלץ מהטקסט שתי רשימות:

1. ישויות (entities):
   • person       — שם אדם
   • company      — חברה מסחרית
   • association  — עמותה / מלכ"ר
   • supplier     — ספק / קבלן
   • role         — תפקיד
   • amount       — סכום כסף
   • date         — תאריך
   • tender       — מספר מכרז
   • tavr         — מספר תב"ר
   • address      — כתובת
   • project      — שם פרויקט

2. קשרים (relationships):
   • paid_to / received_from / contractor_of
   • signed_by / related_to / part_of / manages / approved_by

הוראות:
- JSON בלבד, ללא טקסט נוסף
- value: הערך המדויק מהטקסט
- value_norm: גרסה מנורמלת (ללא בע"מ/עמותת/חברת)
- context: משפט קצר מהטקסט

טקסט:
"""
${chunk.content.slice(0, 3000)}
"""

פורמט:
{"entities":[{"entity_type":"...","value":"...","value_norm":"...","context":"..."}],"relationships":[{"entity_a":"...","relation_type":"...","entity_b":"...","context":"..."}]}`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      MODEL,
      max_tokens: 2000,
      messages:   [{ role:'user', content: prompt }],
    }, {
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 30_000,
    });

    const text  = res.data.content?.[0]?.text || '{"entities":[],"relationships":[]}';
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();

    // לוג לאבחון
    logger.info(`Claude raw response (first 500 chars): ${clean.slice(0,500)}`, { docId: docMeta.id });

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch(parseErr) {
      logger.error(`JSON parse failed: ${parseErr.message}`, { docId: docMeta.id });
      logger.error(`Full raw text: ${clean}`, { docId: docMeta.id });
      return { entities: [], relationships: [] };
    }

    const entities = (parsed.entities || [])
      .filter(e => e.value && e.entity_type)
      .map(e => ({
        doc_id:      docMeta.id,
        chunk_id:    chunk.id,
        entity_type: e.entity_type,
        value:       String(e.value).slice(0, 500),
        value_norm:  norm(e.value_norm || e.value, e.entity_type),
        context:     String(e.context || '').slice(0, 300),
        confidence:  1.0,
        page_number: chunk.page_num || null,
      }));

    const relationships = (parsed.relationships || [])
      .filter(r => r.entity_a && r.entity_b && r.relation_type)
      .map(r => ({
        doc_id:        docMeta.id,
        chunk_id:      chunk.id,
        entity_a_norm: norm(r.entity_a, 'company'),
        entity_b_norm: norm(r.entity_b, 'company'),
        relation_type: r.relation_type,
        context:       String(r.context || '').slice(0, 300),
      }));

    return { entities, relationships };

  } catch (err) {
    logger.warn(`Chunk failed: ${err.message}`, { docId: docMeta.id });
    return { entities: [], relationships: [] };
  }
}

function norm(value, type) {
  let v = String(value || '').trim().replace(/\s+/g,' ');
  if (['supplier','company','association','person'].includes(type)) {
    v = v
      .replace(/\s*בע["״]מ\s*$/i,'')
      .replace(/\s*ע\.ר\.\s*$/i,'')
      .replace(/\s*עמותת\s*/i,'')
      .replace(/\s*חברת\s*/i,'')
      .trim();
  }
  if (type === 'amount') v = v.replace(/[,\s₪]/g,'').trim();
  return v.slice(0, 300);
}
