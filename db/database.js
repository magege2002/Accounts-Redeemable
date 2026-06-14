const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'ar.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS matters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num TEXT UNIQUE NOT NULL,
    client TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS staging_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matter TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0.1,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Administrative',
    type TEXT NOT NULL DEFAULT 'Time',
    rate REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Ready',
    source TEXT NOT NULL DEFAULT 'manual', -- valid: panel_a, panel_b, wisetime, notabill, split, call_log, cloned, manual
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS archive_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_label TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    total_hours REAL NOT NULL DEFAULT 0,
    total_billable REAL NOT NULL DEFAULT 0,
    exported_at TEXT NOT NULL DEFAULT (datetime('now')),
    csv_content TEXT NOT NULL DEFAULT ''
  );
`);

// Seed matters if empty
const count = db.prepare('SELECT COUNT(*) as c FROM matters').get();
if (count.c === 0) {
  const insert = db.prepare('INSERT OR IGNORE INTO matters (num, client, rate, active) VALUES (?, ?, ?, 1)');
  const seeds = [
    { num: '00023-Lewis',    client: 'Brenda Lewis',           rate: 30  },
    { num: '00027-Alfonso',  client: 'Pedro Alfonso (DCI)',    rate: 125 },
    { num: '00029-Gill',     client: 'Lauren Gill',            rate: 30  },
    { num: '00031-Eubanks',  client: 'Leanora Eubanks',       rate: 30  },
    { num: '00034-Whalen',   client: 'Steven Whalen',          rate: 30  },
    { num: '00039-Evans',    client: 'Maria Evans',            rate: 30  },
    { num: '00044-Davidson', client: 'Davidson (Internal)',    rate: 30  },
    { num: '00047-Adams',    client: 'Damon Adams',            rate: 30  },
    { num: '00050-Shearin',  client: 'Denise Shearin',         rate: 30  },
    { num: '00051-Marshall', client: 'Shantel Marshall (Med)', rate: 30  },
    { num: '00056-People',   client: 'Cynthia People',         rate: 30  },
    { num: '00057-Ray',      client: 'Lauren Ray',             rate: 125 },
    { num: '00058-Marshall', client: 'Shantel Marshall (Emp)', rate: 125 },
    { num: '00059-Bradley',  client: 'Nkosi Bradley',          rate: 125 },
    { num: '00020-Ali',      client: 'Bilal Ali',              rate: 30  },
  ];
  db.exec('BEGIN');
  try {
    for (const s of seeds) insert.run(s.num, s.client, s.rate);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Idempotent column migrations — run on every boot, safe to re-run
(function migrate() {
  const entryCols = db.prepare('PRAGMA table_info(staging_entries)').all().map(c => c.name);
  if (!entryCols.includes('expense_type'))
    db.exec("ALTER TABLE staging_entries ADD COLUMN expense_type TEXT NOT NULL DEFAULT 'HardCostEntry'");
  if (!entryCols.includes('vendor_name'))
    db.exec("ALTER TABLE staging_entries ADD COLUMN vendor_name TEXT NOT NULL DEFAULT ''");

  const archiveCols = db.prepare('PRAGMA table_info(archive_cycles)').all().map(c => c.name);
  if (!archiveCols.includes('cycle_type'))
    db.exec("ALTER TABLE archive_cycles ADD COLUMN cycle_type TEXT NOT NULL DEFAULT 'activities'");
  if (!archiveCols.includes('export_date'))
    db.exec("ALTER TABLE archive_cycles ADD COLUMN export_date TEXT NOT NULL DEFAULT ''");
})();

// node:sqlite returns lastInsertRowid as BigInt — normalise it
const _origPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = _origPrepare(sql);
  const _origRun = stmt.run.bind(stmt);
  stmt.run = (...args) => {
    const result = _origRun(...args);
    if (result && typeof result.lastInsertRowid === 'bigint') {
      result.lastInsertRowid = Number(result.lastInsertRowid);
    }
    return result;
  };
  return stmt;
};

// Polyfill db.transaction() to match better-sqlite3's API.
// node:sqlite has no native transaction() method; this wraps BEGIN/COMMIT/ROLLBACK
// so routes can use: const insertMany = db.transaction(fn); insertMany(args);
db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
};

module.exports = db;
