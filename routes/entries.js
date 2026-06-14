const express = require('express');
const router = express.Router();
const db = require('../db/database');

const VALID_CATEGORIES = [
  'Phone call', 'Text exchange', 'Document review',
  'Research', 'Court filing', 'Administrative',
  'Notes — Timed', 'Notes — Estimated'
];

function sanitize(e) {
  return {
    matter:       String(e.matter       || ''),
    client:       String(e.client       || ''),
    date:         String(e.date         || new Date().toISOString().slice(0, 10)),
    duration:     parseFloat(e.duration)   || 0.1,
    description:  String(e.description  || ''),
    category:     VALID_CATEGORIES.includes(e.category) ? e.category : 'Administrative',
    type:         e.type === 'Expense' ? 'Expense' : 'Time',
    rate:         parseFloat(e.rate)       || 0,
    status:       ['Ready', 'Needs Review', 'Approved'].includes(e.status) ? e.status : 'Ready',
    source:       String(e.source       || 'manual'),
    expense_type: ['HardCostEntry', 'SoftCostEntry'].includes(e.expense_type) ? e.expense_type : 'HardCostEntry',
    vendor_name:  String(e.vendor_name  || ''),
  };
}

const SELECT_ALL = "SELECT * FROM staging_entries ORDER BY (status = 'Needs Review') DESC, created_at ASC";

router.get('/', (req, res) => {
  res.json(db.prepare(SELECT_ALL).all());
});

router.post('/', (req, res) => {
  // CHECKPOINT 2: body as received after Express JSON parsing
  console.log('[POST /api/entries] CHECKPOINT 2 — raw body description:', JSON.stringify(req.body.description));
  console.log('[POST /api/entries] CHECKPOINT 2 — full body:', JSON.stringify(req.body));

  const s = sanitize(req.body);

  // CHECKPOINT 3: immediately before SQLite insert
  console.log('[POST /api/entries] CHECKPOINT 3 — sanitized description:', JSON.stringify(s.description));
  console.log('[POST /api/entries] CHECKPOINT 3 — full sanitized row:', JSON.stringify(s));

  const info = db.prepare(`
    INSERT INTO staging_entries
      (matter, client, date, duration, description, category, type, rate, status, source, expense_type, vendor_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.matter, s.client, s.date, s.duration, s.description, s.category, s.type, s.rate, s.status, s.source, s.expense_type, s.vendor_name);

  const inserted = db.prepare('SELECT * FROM staging_entries WHERE id = ?').get(info.lastInsertRowid);
  console.log('[POST /api/entries] CHECKPOINT 3b — inserted row description:', JSON.stringify(inserted.description));
  res.json(inserted);
});

router.post('/batch', (req, res) => {
  const entries = Array.isArray(req.body) ? req.body : [];
  const insert = db.prepare(`
    INSERT INTO staging_entries
      (matter, client, date, duration, description, category, type, rate, status, source, expense_type, vendor_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    const inserted = [];
    for (const e of rows) {
      const s = sanitize(e);
      const info = insert.run(s.matter, s.client, s.date, s.duration, s.description, s.category, s.type, s.rate, s.status, s.source, s.expense_type, s.vendor_name);
      inserted.push(db.prepare('SELECT * FROM staging_entries WHERE id = ?').get(info.lastInsertRowid));
    }
    return inserted;
  });
  res.json(insertMany(entries));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM staging_entries WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const s = sanitize({ ...existing, ...req.body });
  db.prepare(`
    UPDATE staging_entries
    SET matter=?, client=?, date=?, duration=?, description=?, category=?, type=?, rate=?,
        status=?, source=?, expense_type=?, vendor_name=?
    WHERE id=?
  `).run(s.matter, s.client, s.date, s.duration, s.description, s.category, s.type, s.rate,
         s.status, s.source, s.expense_type, s.vendor_name, req.params.id);
  res.json(db.prepare('SELECT * FROM staging_entries WHERE id = ?').get(req.params.id));
});

router.delete('/all', (req, res) => {
  db.prepare('DELETE FROM staging_entries').run();
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM staging_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
