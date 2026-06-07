import axios  from 'axios';
import logger from './logger.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

/* =============================================
   חלץ ישויות + קשרים מ-chunk דרך Claude
============================================= */
export async function extractFromChunk(chunk, docMeta) {

  const prompt = `אתה מומחה לחילוץ מידע ממסמכים ממשלתיים ועירוניים בישראל.

חלץ מהטקסט הבא שתי רשימות:

1. ישויות (entities) — כל ישות מהסוגים הבאים:
   • person       — שם אדם (ראש עיר, מנהל, חתום על מסמך, מועצה)
   • company      — חברה מסחרית (בע"מ, חברה)
   • association  — עמותה / מלכ"ר (ע"ר, עמותת)
   • supplier     — ספק / קבלן שמספק שירות לעירייה
   • role         — תפקיד (ראש עיר, גזבר, מנכ"ל, יו"ר ועדה)
   • amount       — סכום כסף (₪, שקל, מיליון)
   • date         — תאריך (DD/MM/YYYY, חודש+שנה, רבעון)
   • tender       — מספר מכרז (12/2024, מכרז מס')
   • tavr         — מספר תב"ר (תכנית ביצוע רב שנתית)
   • address      — כתובת רחוב
   • project      — שם פרויקט / מיזם

2. קשרים (relationships) — בין ישויות שמצאת:
   סוגי קשרים אפשריים:
   • paid_to         — שילם ל / העביר כספים ל
   • received_from   — קיבל תשלום מ
   • contractor_of   — קבלן / ספק של / זכה במכרז
   • signed_by       — חתום על ידי
   • related_to      — קשור ל / מופיע יחד עם
   • part_of         — חלק מ / שייך ל
   • manages         — מנהל / אחראי על
   • approved_by     — אושר על ידי

הוראות:
- החזר JSON בלבד, ללא כל טקסט נוסף
- value: הערך המדויק כפי שמופיע בטקסט
- value_norm: גרסה מנורמלת (נקי, ללא "בע"מ"/"עמותת" בסוף)
- context: משפט קצר מהטקסט שמסביר ההקשר
- בקשרים: entity_a ו-entity_b הם value_norm של שתי ישויות
- אם אין ישויות — החזר {"entities":[],"relationships":[]}

טקסט:
"""
${chunk.content.slice(0, 3000)}
"""

החזר JSON בדיוק בפורמט:
{
  "entities": [
    {"entity_type":"person","value":"ישראל ישראלי","value_norm":"ישראל ישראלי","context":"ראש העיר חתם על..."}
  ],
  "relationships": [
    {"entity_a":"עיריית נתיבות","relation_type":"paid_to","entity_b":"חברת כבישים","context":"העירייה שילמה לחברה..."}
  ]
}`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      MODEL,
      max_tokens: 2000,
      messages:   [{ role:'user', content: prompt }],
    }, {
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 30_000,
    });

    const text  = res.data.content?.[0]?.text || '{"entities":[],"relationships":[]}';
    const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const parsed = JSON.parse(clean);

    const entities = (parsed.entities || [])
      .filter(e => e.value && e.entity_type)
      .map(e => ({
        doc_id:      docMeta.id,
        chunk_id:    chunk.id,
        entity_type: e.entity_type,
        value:       String(e.value).slice(0, 500),
        value_norm:  normalizeValue(e.value_norm || e.value, e.entity_type),
        context:     String(e.context || '').slice(0, 300),
        confidence:  e.confidence || 1.0,
        page_number: chunk.page_number || null,
      }));

    const relationships = (parsed.relationships || [])
      .filter(r => r.entity_a && r.entity_b && r.relation_type)
      .map(r => ({
        doc_id:        docMeta.id,
        chunk_id:      chunk.id,
        entity_a_norm: normalizeValue(r.entity_a, 'company'),
        entity_b_norm: normalizeValue(r.entity_b, 'company'),
        relation_type: r.relation_type,
        context:       String(r.context || '').slice(0, 300),
      }));

    return { entities, relationships };

  } catch (err) {
    logger.warn(`Chunk extraction failed: ${err.message}`, { docId: docMeta.id });
    return { entities: [], relationships: [] };
  }
}

/* ---- נרמול ---- */
function normalizeValue(value, type) {
  let v = String(value || '').trim().replace(/\s+/g,' ');

  if (['supplier','company','association','person'].includes(type)) {
    v = v
      .replace(/\s*בע["״]מ\s*$/i, '')
      .replace(/\s*ע\.ר\.\s*$/i, '')
      .replace(/\s*עמותת\s*/i, '')
      .replace(/\s*חברת\s*/i, '')
      .replace(/\s*עיריית\s*/i, 'עיריית ')
      .trim();
  }

  if (type === 'amount') {
    v = v.replace(/[,\s]/g,'').replace(/[₪]/g,'').trim();
  }

  return v.slice(0, 300);
}
