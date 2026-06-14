require('dotenv').config({ override: true });
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/matters', require('./routes/matters'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/export', require('./routes/export'));
app.use('/api/archive', require('./routes/archive'));
app.use('/api/audit',   require('./routes/audit'));

app.get('/api/status', (req, res) => {
  const db = require('./db/database');
  const row = db.prepare(
    "SELECT COUNT(*) as count, SUM(duration * rate) as billable FROM staging_entries"
  ).get();
  res.json({
    ok: true,
    entryCount:    row.count    || 0,
    totalBillable: row.billable || 0,
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Accounts Redeemable running at http://localhost:${PORT}`);
});
