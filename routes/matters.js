const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM matters ORDER BY active DESC, num ASC').all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { num, client, rate } = req.body;
  if (!num || !client) return res.status(400).json({ error: 'num and client required' });
  try {
    const info = db.prepare('INSERT INTO matters (num, client, rate, active) VALUES (?, ?, ?, 1)').run(num, client, parseFloat(rate) || 0);
    const row = db.prepare('SELECT * FROM matters WHERE id = ?').get(info.lastInsertRowid);
    res.json(row);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Matter number already exists' });
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const { num, client, rate, active } = req.body;
  const fields = [];
  const vals = [];
  if (num !== undefined)    { fields.push('num = ?');    vals.push(num); }
  if (client !== undefined) { fields.push('client = ?'); vals.push(client); }
  if (rate !== undefined)   { fields.push('rate = ?');   vals.push(parseFloat(rate) || 0); }
  if (active !== undefined) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE matters SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const row = db.prepare('SELECT * FROM matters WHERE id = ?').get(req.params.id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM matters WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
