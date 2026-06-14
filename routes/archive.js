const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.get('/', (req, res) => {
  const cycles = db.prepare('SELECT * FROM archive_cycles ORDER BY id DESC').all();
  res.json(cycles);
});

router.get('/:id/download', (req, res) => {
  const cycle = db.prepare('SELECT * FROM archive_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) return res.status(404).json({ error: 'Not found' });

  // Use stored export_date (YYYY-MM-DD) when available; fall back to the date
  // portion of exported_at (SQLite datetime string: "YYYY-MM-DD HH:MM:SS")
  const dateStr = (cycle.export_date && cycle.export_date.length === 10)
    ? cycle.export_date
    : (cycle.exported_at || '').slice(0, 10);

  const prefix = cycle.cycle_type === 'expenses' ? 'clio-expenses' : 'clio-activities';
  const filename = `${prefix}-${dateStr}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(cycle.csv_content);
});

module.exports = router;
