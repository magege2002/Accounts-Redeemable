const express = require('express');
const router = express.Router();
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function getActiveMatters() {
  return db.prepare('SELECT * FROM matters WHERE active = 1 ORDER BY num').all();
}

// Build a formatted matter reference list for audit prompts
function buildMatterRefList(matters) {
  return matters.map(m => `${m.num} | ${m.client} | $${m.rate}/hr`).join('\n');
}

// Extract distinct client surnames/keywords for confidentiality cross-check
function buildClientSurnameList(matters) {
  return matters.map(m => {
    // Pull the first token after any leading word (handles "Brenda Lewis", "Pedro Alfonso (DCI)", etc.)
    const parts = m.client.replace(/\(.*\)/, '').trim().split(/\s+/);
    return parts[parts.length - 1]; // last token is usually surname
  }).filter(Boolean).join(', ');
}

// ── POST /api/audit/upload — AR Export Audit ─────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const matters        = getActiveMatters();
  const matterRefList  = buildMatterRefList(matters);
  const clientSurnames = buildClientSurnameList(matters);

  const stagingEntries = db.prepare('SELECT * FROM staging_entries ORDER BY matter, date').all();
  const archiveCycles  = db.prepare('SELECT * FROM archive_cycles ORDER BY id DESC LIMIT 6').all();

  const stagingText = stagingEntries.length
    ? stagingEntries.map(e =>
        `${e.matter} | ${e.date} | ${e.duration}h | $${e.rate}/hr | ${e.category} | ${e.description}`
      ).join('\n')
    : '(no staging entries)';

  const archiveText = archiveCycles.length
    ? archiveCycles.map(c => `--- ${c.month_label} (${c.cycle_type}) ---\n${c.csv_content}`).join('\n\n')
    : '(no archive records)';

  const instructions = `You are a legal billing auditor for Accounts Redeemable (AR) for attorney Michael Agege.

Compare the uploaded billing export against the AR records below and return ONLY a JSON array of issues found.

=== ACTIVE MATTER REFERENCE LIST (matter | client | standard rate) ===
${matterRefList}

=== KNOWN CLIENT SURNAMES (for confidentiality cross-check) ===
${clientSurnames}

=== CURRENT AR STAGING ENTRIES ===
${stagingText}

=== RECENT ARCHIVE EXPORTS ===
${archiveText}

=== AUDIT CHECKS — apply ALL of the following ===

1. DUPLICATE — same matter + date + note similarity above 70% word overlap AND same activity_description category.
   EXEMPTION: Do NOT flag as duplicate when one entry has activity_description "Phone call" and the other has "Notes — Timed" or "Notes — Estimated" on the same matter and date. A call entry and a note-taking entry for the same matter/date are intentionally separate billable activities.
   Use the note column (full description text) for similarity comparison — not the activity_description column.

2. CONFIDENTIALITY_RISK — the note field contains a client name, surname, or matter reference that does not match the assigned matter column. Example: a row assigned to matter 00023-Lewis whose note mentions "Bradley", "Alfonso", or any other client surname from the reference list is a confidentiality risk. Every client's note must reference only that client's matter. This is a critical finding.

3. SWAPPED_COLUMNS — EITHER: (a) the note column contains only a short category label such as "Phone call", "Text exchange", "Document review", "Research", "Court filing", "Administrative", "Notes — Timed", or "Notes — Estimated" with no further billing description, OR (b) the activity_description column contains a full sentence or description exceeding 40 characters. Either condition indicates the note and activity_description columns were transposed at import.

4. RATE_MISMATCH — the price or rate value for a row differs from the standard hourly rate for that matter in the active matter reference list. Flag any deviation.

5. MISSING_MATTER — the matter column is empty, blank, or does not match any matter number in the active reference list.

6. MISSING — an entry in the uploaded file has no corresponding match in the AR staging entries or archive records (same matter + date + similar note not found anywhere in AR).

Return ONLY a JSON array using these exact type strings. No markdown, no explanation:
[{"type":"DUPLICATE","row":"matter | date | description excerpt","details":"explanation of the issue","recommendation":"action to take"}]

For CONFIDENTIALITY_RISK entries, include the conflicting client name in the details field.
If no issues are found, return exactly: []`;

  try {
    let messageContent;

    if (req.file.mimetype === 'application/pdf') {
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') },
        },
        { type: 'text', text: instructions },
      ];
    } else {
      const fileText = req.file.buffer.toString('utf-8');
      messageContent = `${instructions}\n\n=== UPLOADED FILE (${req.file.originalname}) ===\n${fileText}`;
    }

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: messageContent }],
    });

    const raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    console.log('[audit/upload] raw AI response length:', raw.length);

    let flags;
    try {
      flags = JSON.parse(raw);
    } catch (parseErr) {
      console.error('[audit/upload] JSON.parse failed. Raw was:', raw);
      throw parseErr;
    }

    res.json({ flags, fileName: req.file.originalname, fileType: req.file.mimetype });
  } catch (e) {
    console.error('Audit error:', e);
    res.status(500).json({ error: e.message || 'Audit failed' });
  }
});

// ── POST /api/audit/general — General Invoice Audit ──────────────────────
router.post('/general', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const matters        = getActiveMatters();
  const matterRefList  = buildMatterRefList(matters);
  const clientSurnames = buildClientSurnameList(matters);

  const instructions = `You are a legal billing auditor reviewing an invoice or activity export file for attorney Michael Agege.

Analyse the uploaded file on its own merits — do NOT compare against external records.

=== ACTIVE MATTER REFERENCE LIST (matter | client | standard rate) ===
${matterRefList}

=== KNOWN CLIENT SURNAMES (for confidentiality cross-check) ===
${clientSurnames}

=== AUDIT CHECKS — apply ALL of the following ===

1. DUPLICATE — two or more rows within this file share the same matter + date AND have note similarity above 70% word overlap AND share the same activity_description category.
   EXEMPTION: Do NOT flag as duplicate when one entry has activity_description "Phone call" and the other has "Notes — Timed" or "Notes — Estimated" on the same matter and date. These are intentionally separate billable activities — a call and a note-taking entry on the same matter/date is expected and correct.
   In the details field, show both conflicting rows so they can be identified.

2. CONFIDENTIALITY_RISK — the note field contains a client name, surname, or matter reference that does not match the assigned matter column. Every entry's note must reference only the client whose matter is assigned to that row. Include the conflicting name in the details field. This is a critical finding.

3. SHORT_NOTE — the note field is fewer than 10 characters. A billing description this short is not a defensible record for a client invoice.

4. SWAPPED_COLUMNS — EITHER: (a) the note column contains only a short category label (Phone call, Text exchange, Document review, Research, Court filing, Administrative, Notes — Timed, Notes — Estimated) with no further description, OR (b) the activity_description column contains a full sentence or description exceeding 40 characters. Either indicates swapped columns.

5. RATE_ANOMALY — the price for a row differs from the standard rate for that matter in the active reference list. Flag any deviation where the matter is identifiable.

6. MISSING_MATTER — the matter column is empty, blank, or does not match any matter number in the active reference list.

Return ONLY a JSON array using these exact type strings. No markdown, no explanation:
[{"type":"DUPLICATE","row":"matter | date | description excerpt","details":"explanation","recommendation":"action to take"}]

If no issues are found, return exactly: []

You must respond with a valid JSON array only. No preamble, no explanation, no markdown. Your entire response must start with [ and end with ].`;

  // ── SSE setup ─────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = data => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // ── 30-second timeout per API call ────────────────────────────────────
  async function withTimeout(promise, ms = 30000) {
    let t;
    const timeout = new Promise((_, rej) =>
      t = setTimeout(() => rej(new Error('Audit timed out — try a smaller file or fewer rows.')), ms)
    );
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
  }

  // ── Chunk runner — sends SSE progress, returns parsed flags or null ───
  async function runAuditChunk(chunkText, batchNum, totalBatches) {
    sendEvent({ type: 'progress', batch: batchNum, total: totalBatches,
                msg: `Analysing batch ${batchNum} of ${totalBatches}…` });
    const batchLabel = totalBatches > 1 ? ` — batch ${batchNum}/${totalBatches}` : '';
    const content = `${instructions}\n\n=== UPLOADED FILE (${req.file.originalname}${batchLabel}) ===\n${chunkText}`;
    let msg;
    try {
      msg = await withTimeout(
        client.messages.create({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content }] })
      );
    } catch (e) {
      console.error(`[audit/general] batch ${batchNum}/${totalBatches} failed:`, e.message);
      sendEvent({ type: 'batchError', batch: batchNum, error: e.message });
      return null;
    }
    let raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const bs = raw.indexOf('[');
    if (bs === -1) {
      console.error(`[audit/general] batch ${batchNum}: no JSON array. Raw:`, raw.slice(0, 300));
      return null;
    }
    if (bs > 0) raw = raw.slice(bs);
    console.log(`[audit/general] batch ${batchNum}/${totalBatches} response length:`, raw.length);
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`[audit/general] batch ${batchNum}: JSON.parse failed`);
      return null;
    }
  }

  try {
    // ── PDF path ─────────────────────────────────────────────────────────
    if (req.file.mimetype === 'application/pdf') {
      sendEvent({ type: 'progress', batch: 1, total: 1, msg: 'Analysing PDF…' });
      const messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') },
        },
        { type: 'text', text: instructions },
      ];
      let msg;
      try {
        msg = await withTimeout(
          client.messages.create({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: messageContent }] })
        );
      } catch (e) {
        sendEvent({ type: 'error', error: e.message });
        return res.end();
      }
      let raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
      const bs = raw.indexOf('[');
      if (bs === -1) {
        console.error('[audit/general] No JSON array in PDF response. Raw:\n', raw);
        sendEvent({ type: 'error', error: 'Audit returned unexpected format — try a smaller file.' });
        return res.end();
      }
      if (bs > 0) raw = raw.slice(bs);
      console.log('[audit/general] PDF response length:', raw.length);
      let flags;
      try {
        flags = JSON.parse(raw);
      } catch {
        console.error('[audit/general] PDF JSON.parse failed');
        sendEvent({ type: 'error', error: 'Audit returned unexpected format — could not parse response.' });
        return res.end();
      }
      sendEvent({ type: 'result', flags, fileName: req.file.originalname, fileType: req.file.mimetype, totalRows: 0 });
      return res.end();
    }

    // ── Text / CSV path ───────────────────────────────────────────────────
    const fileText = req.file.buffer.toString('utf-8');
    const lines    = fileText.split('\n');
    const header   = lines[0];
    const dataRows = lines.slice(1).filter(l => l.trim() !== '');

    const BATCH_ROWS   = 40;
    const SINGLE_LIMIT = 50;

    if (dataRows.length <= SINGLE_LIMIT) {
      // Small file — single API call
      const flags = await runAuditChunk(fileText, 1, 1);
      if (flags === null) {
        sendEvent({ type: 'error', error: 'Audit returned unexpected format — try a smaller file or fewer rows.' });
      } else {
        sendEvent({ type: 'result', flags, fileName: req.file.originalname, fileType: req.file.mimetype, totalRows: dataRows.length });
      }
      return res.end();
    }

    // Large file — row-based batching (40 rows per batch)
    const batches = [];
    for (let i = 0; i < dataRows.length; i += BATCH_ROWS) {
      batches.push([header, ...dataRows.slice(i, i + BATCH_ROWS)].join('\n'));
    }

    const allFlags = [];
    for (let i = 0; i < batches.length; i++) {
      const chunkFlags = await runAuditChunk(batches[i], i + 1, batches.length);
      if (chunkFlags) allFlags.push(...chunkFlags);
    }

    sendEvent({ type: 'result', flags: allFlags, fileName: req.file.originalname, fileType: req.file.mimetype, totalRows: dataRows.length });
    return res.end();

  } catch (e) {
    console.error('General audit error:', e);
    sendEvent({ type: 'error', error: e.message || 'General audit failed' });
    return res.end();
  }
});

module.exports = router;
