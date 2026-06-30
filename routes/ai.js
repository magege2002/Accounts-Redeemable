const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function getActiveMatters() {
  return db.prepare('SELECT * FROM matters WHERE active = 1 ORDER BY num').all();
}

function getMatter(num) {
  return db.prepare('SELECT * FROM matters WHERE num = ?').get(num);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Shared regex that strips procedural annotation suffixes — defined once in proc-suffix.js
const PROC_SUFFIX_RE = require('./proc-suffix');

const CALL_LANG_RE = /call|phone|spoke|talked|rang|dialed|voicemail/i;

function buildParsedEntries(parsed, source, defaultCategory) {
  const today = todayStr();
  return parsed.map(p => {
    const m = getMatter(p.matter);
    const cat = p.category || defaultCategory || 'Administrative';
    // isSplit and isCallLog are AI-set flags that override the panel source for badge rendering
    let effectiveSource = source;
    if (p.isSplit)   effectiveSource = 'split';
    if (p.isCallLog) effectiveSource = 'call_log';
    // Strip any procedural suffix the AI may have appended despite prompt instructions.
    // Entry origin is conveyed by the source badge, never by the description field.
    const rawDesc = (p.description || '').trim();
    const description = rawDesc.replace(PROC_SUFFIX_RE, '').trim();
    const raw_note = p.raw_note || '';
    const needs_call_time = (
      cat === 'Notes — Estimated' &&
      (CALL_LANG_RE.test(raw_note) || CALL_LANG_RE.test(description))
    ) ? 1 : 0;
    return {
      matter:          p.matter  || '',
      client:          m ? m.client : (p.client || ''),
      date:            p.date    || today,
      duration:        parseFloat(p.duration) || 0.1,
      description,
      category:        cat,
      type:            p.type === 'Expense' ? 'Expense' : 'Time',
      rate:            m ? m.rate : 0,
      status:          p.needsReview ? 'Needs Review' : 'Ready',
      source:          effectiveSource,
      raw_note,
      needs_call_time,
    };
  });
}

// POST /api/ai/extract-docx — extract text from uploaded docx
router.post('/extract-docx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    res.json({ text: result.value });
  } catch (e) {
    console.error('Mammoth error:', e);
    res.status(500).json({ error: 'Failed to extract docx text' });
  }
});

// ── Panel A chunking helper ────────────────────────────────────────────────
const CHUNK_CHARS = 3000;

// Groups raw text into entry blocks (blank-line-separated), then chunks
// by whole blocks so that multi-line entries are never split across API calls
// and blank-line boundaries are preserved for the AI to read.
function splitIntoChunks(text) {
  // Group consecutive non-blank lines into blocks; blank lines = entry boundary
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.trim()) {
      current.push(line);
    } else if (current.length) {
      blocks.push(current.slice());
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  if (!blocks.length) return [];

  // Re-join blocks with \n\n so blank-line separators are visible to the AI
  const allText = blocks.map(b => b.join('\n')).join('\n\n');
  if (allText.length <= CHUNK_CHARS) {
    return [{ context: '', lines: allText }];
  }

  // Accumulate whole blocks into chunks up to CHUNK_CHARS
  // — never break mid-block so multi-line entries stay together
  const chunks = [];
  let i = 0;
  let prevTailText = '';

  while (i < blocks.length) {
    const chunkBlocks = [];
    let len = 0;
    while (i < blocks.length) {
      const blockText = blocks[i].join('\n');
      const cost = len === 0 ? blockText.length : blockText.length + 2; // +2 for \n\n joiner
      if (len > 0 && len + cost > CHUNK_CHARS) break;
      chunkBlocks.push(blocks[i]);
      len += cost;
      i++;
    }
    // Safety: single block that alone exceeds CHUNK_CHARS — include it anyway
    if (chunkBlocks.length === 0 && i < blocks.length) {
      chunkBlocks.push(blocks[i++]);
    }
    chunks.push({
      context: prevTailText,
      lines:   chunkBlocks.map(b => b.join('\n')).join('\n\n'),
    });
    // Carry the last complete block as context for the next chunk
    prevTailText = chunkBlocks[chunkBlocks.length - 1].join('\n');
  }
  return chunks;
}

// POST /api/ai/parse-text — Panel A: raw notes or docx text → structured entries
router.post('/parse-text', express.json({ limit: '2mb' }), async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const matters = getActiveMatters();
  const matterList = matters.map(m => `${m.num} (${m.client})`).join(', ');
  const today = todayStr();

  // Prompt prefix — reused for every chunk call
  const PROMPT_PREFIX = `**YOU MUST RESPOND WITH A VALID JSON ARRAY ONLY. No preamble, no explanation, no markdown, no code fences, no conversational text whatsoever. Your entire response must start with [ and end with ]. If you cannot parse an entry, include it in the array with needsReview: true. Never write any text outside the JSON array.**

You are a legal billing parser for attorney Michael Agege. Convert raw time entry notes into structured billing JSON.

Today's date: ${today}
Active matters: ${matterList}

=== ENTRY BOUNDARIES ===
Raw notes may contain multi-line entries. Identify where one entry ends and the next begins using these rules in order:

1. BLANK LINE = ENTRY BOUNDARY: A blank line always marks the boundary between two separate entries. All lines within a single block (no blank line between them) belong to ONE entry — combine them before parsing.

2. NEW TIME INCREMENT = NEW ENTRY: A new entry also begins when a line starts with a time pattern (e.g. "0.3", ".2", "15 min", "30m", "1hr", "1 hr 30min") even if no blank line precedes it. The time increment line starts the new entry; the previous lines form the prior entry.

3. CONTINUATION LINES: Any line that does not start with a time increment and is not separated by a blank line is a continuation of the current entry. Indented lines, bullet points, or plain continuation text within a block are additional context for the same entry — not separate entries.

4. COMBINE BEFORE PARSING: Merge all lines of a block into one combined note before applying any other parsing rule. The combined text is your raw_note for that entry.

=== CATEGORY RULES ===
Choose from EXACTLY these values — no others are valid:
"Phone call" | "Text exchange" | "Document review" | "Research" | "Court filing" | "Administrative" | "Notes — Timed" | "Notes — Estimated"

DEFAULT: Use "Notes — Timed" when the description contains note-taking language: notes, summary, recap, wrote, drafted, compiled, recorded.

Otherwise infer from content:
- "Administrative" — forms, filings, internal tasks, scheduling, billing administration, general admin
- "Document review" — reviewing, reading, analyzing, or examining documents
- "Research" — research, Westlaw, Lexis, looked up, legal search
- "Phone call" — ONLY when description explicitly says "call"
- "Text exchange" — text, SMS, or message exchange
- "Court filing" — court, ECF, filing, motion, submitted documents

"Notes — Estimated" is used ONLY when no time increment is provided — generate a reasonable estimate and set needsReview: true.

=== DURATION ===
Convert to decimal hours in 0.1 increments: "1hr 30min" → 1.5, "15 min" → 0.3, "6 min" → 0.1.
If NO time increment is provided: use category "Notes — Estimated", generate a reasonable estimate based on described work, set needsReview: true.

=== DATE PARSING ===
Priority order: (1) explicit date in text → (2) timestamp context → (3) note creation date → (4) today (${today}) as last resort.
Parse day names against most recent occurrence: "Mon" → most recent Monday relative to today.

=== DESCRIPTION (invoice-ready — max 80 characters) ===
The description field must be a clean, concise billing description suitable for a client invoice. Apply these rules in order:

1. STANDARD FORMAT EXTRACTION: If the note follows the pattern [duration — description — matter/client on date/time], extract only the middle description segment between the duration marker and the matter/client reference. Everything after the matter/client reference is parsing context only — do NOT include it in the description field.
   Example: "30 min - Reviewed settlement documents - Lewis 5/12" → description: "Reviewed settlement documents"

2. FREE-FORM NOTES: If the note does not follow the standard format, generate a concise 5–10 word summary of the core billable activity. Do NOT reproduce the full note text verbatim.

3. EXCLUSIONS: Never include timestamps, date references, duration markers, or matter/client names in the description field — those belong in their dedicated JSON fields.

4. LENGTH LIMIT: Maximum 80 characters. If the extracted or generated description exceeds 80 characters, truncate at the nearest complete word at or under 80 characters.

5. RAW NOTE: Always return the complete original note text in a separate raw_note field. This gives you full context for matter matching, date parsing, and categorization — but raw_note is never displayed to the user and must not bleed into the description field.

6. NO PROCEDURAL ANNOTATIONS: Never append labels such as "(split entry)", "(split)", "(copy)", "(cloned)", "(duplicate)", or any similar origin or process annotation to the description field. The UI provides origin context via source badges. The description field must contain ONLY billable activity language suitable for a client invoice — nothing else.

=== MATTER MATCHING ===
Match matter numbers from active list by client surname or case context. If unclear, leave empty and set needsReview: true.

=== TEXT MESSAGE ENTRIES ===
Bill at 0.1 hrs per simple exchange (1–3 messages), 0.2–0.3 for substantive exchanges (4+ messages or complex topic).
Include sent/received count in description where identifiable, e.g. "Text exchange re: [topic] (3 sent, 2 received)".

=== SPLIT ENTRIES — MIXED DAVIDSON/CLIENT NOTES ===
Create a Davidson Internal entry (matter "00044-Davidson") ONLY when the note explicitly contains internal firm work alongside client work. Internal firm work means: Wakulla matters, firm administration, business insurance, office operations, internal processes, or any non-client administrative task.

When a note contains BOTH client matter work AND Davidson Internal firm work:
- Create TWO separate JSON entries, allocating time proportionally (each rounded to 0.1)
- Both entries get needsReview: true and isSplit: true
- One entry uses the client matter number; the other uses matter "00044-Davidson"

Do NOT create a Davidson Internal entry when:
- The note discusses only client matters, even if Kerry or Farah is mentioned — a client-focused discussion is billed to the client matter only
- There is no reference to internal firm topics (Wakulla, firm admin, insurance, operations, non-client tasks)

=== INTERNAL COMMUNICATIONS ===
Notes involving communications between Michael and Kerry or Farah — apply this decision tree:

CLIENT-ONLY: Communication covers only client cases, case strategy, document review, or client updates — no internal firm topics → create entries for the client matter(s) discussed only. No Davidson Internal entry.

MIXED (client + internal firm work): Communication covers client matters AND internal firm topics → split: one entry per client matter plus one for 00044-Davidson (isSplit: true, needsReview: true on all).

INTERNAL-ONLY: Communication covers only internal firm topics with no client reference → single entry for 00044-Davidson.

=== ATTORNEY-CLIENT DESCRIPTION ISOLATION ===
This is an attorney-client confidentiality requirement. Descriptions appear on invoices delivered to each respective client. A client must never see another client's name, matter, or case details on their invoice.

When a single note is split into entries covering different clients or matters, each entry's description field must contain ONLY information relevant to that specific client and matter. Before returning each split entry, remove all references to other clients' names, matter names, case details, or any client-identifying information from the description field.

Example — a note covering a call about Lewis, Bradley, and Alfonso:
- Lewis entry description: references only Lewis-specific content — no mention of Bradley or Alfonso
- Bradley entry description: references only Bradley-specific content — no mention of Lewis or Alfonso
- Alfonso entry description: references only Alfonso-specific content — no mention of Lewis or Bradley

Apply this rule to ALL entries that produce more than one billing record from a single note: multi-client calls, Davidson split entries, and any other multi-entry note.

Return ONLY a JSON array, no markdown, no explanation:
[{"matter":"","client":"","date":"YYYY-MM-DD","duration":0.1,"description":"","raw_note":"","category":"Notes — Timed","type":"Time","needsReview":false,"isSplit":false}]`;

  const chunks = splitIntoChunks(text.trim());
  console.log(`[parse-text] input ${text.length} chars → ${chunks.length} chunk(s)`);

  try {
    const allParsed = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const { context, lines } = chunks[ci];

      const contextSection = context
        ? `CONTEXT from previous section (already processed — do NOT produce entries for these lines; use only for date/matter continuity):\n${context}\n\n`
        : '';

      const content = `${PROMPT_PREFIX}\n\n${contextSection}Raw notes:\n${lines}`;

      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content }],
      });

      let raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      console.log(`[parse-text] chunk ${ci + 1}/${chunks.length} — response length: ${raw.length} chars`);

      // Response guard — ensure we start parsing from the first '['
      if (!raw.startsWith('[')) {
        const bracketIdx = raw.indexOf('[');
        if (bracketIdx === -1) {
          console.error(`[parse-text] chunk ${ci + 1} — no JSON array found in response`);
          console.error(`[parse-text] full response: ${raw}`);
          throw new Error('AI returned an unexpected response format — try parsing a smaller batch.');
        }
        console.warn(`[parse-text] chunk ${ci + 1} — response had ${bracketIdx} chars of preamble before '['; slicing`);
        raw = raw.slice(bracketIdx);
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error(`[parse-text] chunk ${ci + 1} JSON.parse failed`);
        console.error(`[parse-text] response length: ${raw.length} chars`);
        console.error(`[parse-text] last 200 chars: ...${raw.slice(-200)}`);
        throw parseErr;
      }

      allParsed.push(...parsed);
      console.log(`[parse-text] chunk ${ci + 1} yielded ${parsed.length} entries (running total: ${allParsed.length})`);
    }

    const entries = buildParsedEntries(allParsed, 'panel_a', 'Notes — Timed');
    res.json({ entries });
  } catch (e) {
    console.error('AI parse error:', e);
    res.status(500).json({ error: e.message || 'AI parsing failed' });
  }
});

// POST /api/ai/extract-screenshots — Panel B: images + optional text → structured entries
router.post('/extract-screenshots', upload.array('images', 100), async (req, res) => {
  const imageFiles = req.files || [];
  const additionalText = req.body.text || '';

  if (!imageFiles.length && !additionalText.trim()) {
    return res.status(400).json({ error: 'No images or text provided' });
  }

  const matters = getActiveMatters();
  const matterList = matters.map(m => `${m.num} (${m.client})`).join(', ');
  const today = todayStr();

  const prompt = `**YOU MUST RESPOND WITH A VALID JSON ARRAY ONLY. No preamble, no explanation, no markdown, no code fences. Your entire response must start with [ and end with ].**

You are a legal billing parser for attorney Michael Agege. Parse VXT internal communication screenshots — calls and texts between Michael and his paralegal Kerry.

Today: ${today}
Active matters: ${matterList}

=== CALL ICONS ===
MISSED CALL (red arrow pointing down): Ignore entirely. Create NO entry.

ANSWERED CALL (shows a timestamp such as "8:23"):
- Convert the timestamp to decimal hours: under 6 min → 0.1 · 6–18 min → 0.2 · 19–30 min → 0.3
- Category: "Notes — Timed"
- Description: "Call notes w/ Kerry re: [primary client matter visible in surrounding message context]"
- Matter: infer from client names visible anywhere in the surrounding conversation. If no client reference is visible, use the Davidson Internal matter from the active matter list.

=== ATTACHED CALL NOTES ===
If a call icon has a Notes attachment visible below it, extract the note content and use it as the description basis. This is the primary matter attribution signal — preserve the original note wording in the description.

=== MESSAGE CONTENT ===
For each distinct client matter referenced in the message thread, create a SEPARATE entry.
- Description: "Text exchange w/ Kerry re: [topic] — [client context]"
- Duration: 0.1 for a simple exchange, 0.2–0.3 for substantive content
- If a message references ONLY internal firm matters (leads, Wakulla, Distance, firm admin) with zero client names, create one Davidson Internal entry at 0.1 hr.

=== ATTORNEY-CLIENT ISOLATION ===
Each entry must reference only its own matter. No cross-client names may appear in any single entry's description.

=== DESCRIPTION FIELD RULES ===
The description must contain ONLY billable activity language. Never append procedural annotations such as "(split entry)", "(split)", "(copy)", "(cloned)", "(duplicate)", or any similar origin or process label. Entry origin is tracked separately via the source field — do not encode it in the description.

=== CATEGORY RULES ===
NEVER create "Phone call" category entries — all entries are either "Notes — Timed" (call-derived) or "Text exchange" (message-derived).
Must be exactly one of: "Text exchange", "Document review", "Research", "Court filing", "Administrative", "Notes — Timed", "Notes — Estimated"

Return ONLY a valid JSON array. Your entire response must start with [ and end with ]:
[{"matter":"","client":"","date":"YYYY-MM-DD","duration":0.1,"description":"","category":"Notes — Timed","type":"Time","needsReview":false,"isCallLog":false}]`;

  try {
    let entries = [];

    // Process images if present
    if (imageFiles.length > 0) {
      // Resize each image so neither dimension exceeds 1568px (Anthropic vision limit)
      const resizedBuffers = await Promise.all(
        imageFiles.map(f =>
          sharp(f.buffer)
            .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
            .toBuffer()
        )
      );

      const imageBlocks = resizedBuffers.map((buf, i) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageFiles[i].mimetype,
          data: buf.toString('base64'),
        },
      }));

      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: prompt + (additionalText ? `\n\nAdditional context/text:\n${additionalText}` : '') },
          ],
        }],
      });

      let raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      const bIdx = raw.indexOf('[');
      if (bIdx > 0) raw = raw.slice(bIdx);
      console.log('[extract-screenshots/images] raw AI response:', raw);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error('[extract-screenshots/images] JSON.parse failed. Raw was:\n', raw);
        throw parseErr;
      }
      entries = buildParsedEntries(parsed, 'panel_b', null);
    } else if (additionalText.trim()) {
      // Text-only call (VXT thread or call log)
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: prompt + `\n\nText content to parse:\n${additionalText}`,
        }],
      });

      let raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      const bIdx = raw.indexOf('[');
      if (bIdx > 0) raw = raw.slice(bIdx);
      console.log('[extract-screenshots/text] raw AI response:', raw);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error('[extract-screenshots/text] JSON.parse failed. Raw was:\n', raw);
        throw parseErr;
      }
      entries = buildParsedEntries(parsed, 'panel_b', null);
    }

    res.json({ entries });
  } catch (e) {
    console.error('AI screenshot error:', e);
    res.status(500).json({ error: e.message || 'AI extraction failed' });
  }
});

// ── POST /api/ai/compress-description — shorten a description to ≤ 80 chars ─
router.post('/compress-description', express.json(), async (req, res) => {
  const { description } = req.body || {};
  if (!description) return res.status(400).json({ error: 'No description provided' });

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Compress this legal billing description to a maximum of 80 characters while preserving the core billable activity. Keep it invoice-ready and professional. Return ONLY the compressed text — no quotes, no explanation, no preamble.

Original (${description.length} chars): ${description}`,
      }],
    });
    const compressed = msg.content.map(b => b.text || '').join('').trim().slice(0, 80);
    res.json({ compressed });
  } catch (e) {
    console.error('[compress-description] error:', e);
    res.status(500).json({ error: e.message || 'Compression failed' });
  }
});

// ── POST /api/ai/scrub-description — remove another client's name from description
router.post('/scrub-description', express.json(), async (req, res) => {
  const { description, surname } = req.body || {};
  if (!description || !surname) return res.status(400).json({ error: 'Missing description or surname' });

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Remove only the specific client surname "${surname}" and any direct references to that person from this legal billing description. You must preserve the complete original description including any trailing parenthetical counts like "(X sent, Y received)". Only remove the specific client surname requested. Do not truncate, summarize, or modify any other part of the description. Return the full description with only the named client reference removed. Return ONLY the scrubbed text — no quotes, no explanation, no preamble.

Original: ${description}`,
      }],
    });
    const scrubbed = msg.content.map(b => b.text || '').join('').trim();
    res.json({ scrubbed });
  } catch (e) {
    console.error('[scrub-description] error:', e);
    res.status(500).json({ error: e.message || 'Scrub failed' });
  }
});

// ── POST /api/ai/refine-needs-review — improve descriptions/categories for NR entries
router.post('/refine-needs-review', express.json({ limit: '1mb' }), async (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'No entries provided' });

  const matters = getActiveMatters();
  const matterList = matters.map(m => `${m.num} (${m.client})`).join(', ');

  const entriesText = entries.map((e, i) =>
    `[${i}] matter=${e.matter || 'UNKNOWN'} | date=${e.date} | duration=${e.duration}h | description="${e.description}"`
  ).join('\n');

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a legal billing reviewer for attorney Michael Agege. These entries were flagged "Needs Review" — improve each one where possible.

Active matters: ${matterList}

Categories (choose exactly one): "Phone call" | "Text exchange" | "Document review" | "Research" | "Court filing" | "Administrative" | "Notes — Timed" | "Notes — Estimated"

For each entry:
1. Improve the description to be invoice-ready and ≤80 characters
2. Assign the correct category from the list above
3. If the matter is identifiable from context, provide the matter number; otherwise keep the existing one
4. Set needsReview: false if the entry is now clean; keep true if still uncertain

Entries to review:
${entriesText}

Return ONLY a JSON array with exactly ${entries.length} objects in the same index order, no markdown:
[{"description":"","category":"Notes — Timed","matter":"","needsReview":false}]`,
      }],
    });

    const raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    console.log('[refine-needs-review] raw response length:', raw.length);

    let refined;
    try {
      refined = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[refine-needs-review] JSON.parse failed. Raw was:', raw);
      throw parseErr;
    }

    res.json({ refined });
  } catch (e) {
    console.error('[refine-needs-review] error:', e);
    res.status(500).json({ error: e.message || 'Refine failed' });
  }
});

module.exports = router;
