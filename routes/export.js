const express = require('express');
const router = express.Router();
const db = require('../db/database');
const PROC_SUFFIX_RE = require('./proc-suffix');

function q(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function safeCategory(e) {
  return (!e.category || e.category.toLowerCase() === 'none') ? 'Administrative' : e.category;
}

// Convert stored ISO date (YYYY-MM-DD) → Clio bulk-import format (MM/DD/YYYY)
function clioDate(isoDate) {
  if (!isoDate) return '';
  const [yyyy, mm, dd] = String(isoDate).split('-');
  return `${mm}/${dd}/${yyyy}`;
}

// Local date as YYYY-MM-DD (used for filenames and archive export_date)
function localIsoDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Activities CSV — TimeEntry rows
const ACT_HEADER = 'matter,date,quantity,price,type,activity_user,activity_description,note';
function activityRow(e) {
  return [
    q(e.matter || ''),
    q(clioDate(e.date)),
    q((parseFloat(e.duration) || 0).toFixed(1)),
    q(parseFloat(e.rate) || 0),
    q('TimeEntry'),
    q('Michael Agege'),
    q(safeCategory(e)),
    q((e.description || '').replace(PROC_SUFFIX_RE, '').trim()),
  ].join(',');
}

// Expenses CSV — ExpenseEntry rows (different column structure)
const EXP_HEADER = 'matter,date,quantity,price,type,activity_description,vendor_name,note';
function expenseRow(e) {
  return [
    q(e.matter || ''),
    q(clioDate(e.date)),
    q(Math.round(parseFloat(e.duration) || 1)),     // quantity — whole units (editable in staging table)
    q(parseFloat(e.rate) || 0),                    // price = amount
    q('ExpenseEntry'),
    q(safeCategory(e)),
    q(e.vendor_name  || ''),
    q((e.description || '').replace(PROC_SUFFIX_RE, '').trim()),
  ].join(',');
}

function exportableRows(type) {
  const base = "SELECT * FROM staging_entries WHERE status IN ('Approved', 'Ready') ORDER BY matter ASC, date ASC";
  const rows = db.prepare(base).all();
  if (type === 'activities') return rows.filter(r => r.type !== 'Expense');
  if (type === 'expenses')   return rows.filter(r => r.type === 'Expense');
  return rows;
}

function archiveCycle(rows, csvContent, cycleType, exportDate) {
  const now = new Date();
  const monthLabel    = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const totalHours    = rows.reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
  const totalBillable = rows.reduce((s, e) => s + (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0), 0);
  db.prepare(`
    INSERT INTO archive_cycles (month_label, entry_count, total_hours, total_billable, exported_at, csv_content, cycle_type, export_date)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
  `).run(monthLabel, rows.length, totalHours, totalBillable, csvContent, cycleType, exportDate);
}

function sendCSV(res, csv, filename) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// GET /api/export/preview?type=all|activities|expenses
router.get('/preview', (req, res) => {
  const type = req.query.type || 'all';
  res.json(exportableRows(type));
});

// POST /api/export/download-activities
router.post('/download-activities', (req, res) => {
  const rows = exportableRows('activities');
  if (!rows.length) return res.status(400).json({ error: 'No activity entries to export' });
  const csv        = ACT_HEADER + '\n' + rows.map(activityRow).join('\n');
  const exportDate = localIsoDate(new Date());
  archiveCycle(rows, csv, 'activities', exportDate);
  sendCSV(res, csv, `clio-activities-${exportDate}.csv`);
});

// POST /api/export/download-expenses
router.post('/download-expenses', (req, res) => {
  const rows = exportableRows('expenses');
  if (!rows.length) return res.status(400).json({ error: 'No expense entries to export' });
  const csv        = EXP_HEADER + '\n' + rows.map(expenseRow).join('\n');
  const exportDate = localIsoDate(new Date());
  archiveCycle(rows, csv, 'expenses', exportDate);
  sendCSV(res, csv, `clio-expenses-${exportDate}.csv`);
});

// GET /api/export/validate
router.get('/validate', (req, res) => {
  const rows = exportableRows('all');
  const errors = [];
  for (const e of rows) {
    if (!e.matter)    errors.push(`"${(e.description||'').substring(0,30)}" — missing matter #`);
    if (!e.date)      errors.push(`"${(e.description||'').substring(0,30)}" — missing date`);
    if (!e.duration || e.duration <= 0) errors.push(`"${(e.description||'').substring(0,30)}" — invalid duration`);
    if (e.type === 'Time' && (!e.rate || e.rate === 0)) errors.push(`"${(e.description||'').substring(0,30)}" — $0 rate on time entry`);
    if (!e.description) errors.push(`Matter ${e.matter||'(none)'} — empty description`);
  }
  const activities = rows.filter(r => r.type !== 'Expense').length;
  const expenses   = rows.filter(r => r.type === 'Expense').length;
  res.json({ count: rows.length, activities, expenses, errors });
});

module.exports = router;
