# Accounts Redeemable — CLAUDE.md

Local legal billing workflow app for attorney Michael Agege ("MA"). Ingests time/expense
entries from several sources, stages them for review, exports Clio-ready CSV.

## Tech stack (verified from package.json, node --version)

- Runtime: Node (tested on v26.1.0; `node:sqlite` requires Node ≥ 22.5).
- Package manager: **npm** (`package-lock.json` present, no pnpm-lock/yarn.lock). `npm start` /
  `npm run dev` (`--watch`, but see "no hot-reload" below — dev script exists, isn't what's run).
- Web: Express 4.19.
- DB: **`node:sqlite`** (`DatabaseSync`, built into Node — not `better-sqlite3`). File at
  `db/ar.db`, WAL mode, foreign keys on.
- `@anthropic-ai/sdk` ^0.52 — all AI parsing/audit calls use model `claude-sonnet-4-6`.
- `mammoth` — .docx → raw text (Panel A/B docx attach).
- `multer` (memory storage, 20MB limit) — file uploads.
- `sharp` — resizes screenshot uploads to ≤1568px before sending to vision API.

## Architecture

`server.js` mounts 6 routers, all under `/api/*`, plus static `public/` and a `GET /api/status`
health/summary endpoint:

| Mount | File | Purpose |
|---|---|---|
| `/api/matters` | `routes/matters.js` | CRUD on the `matters` table (matter #, client, rate, active). |
| `/api/entries` | `routes/entries.js` | CRUD on `staging_entries`; also `POST /merge-vxt`. |
| `/api/ai` | `routes/ai.js` | All Claude-backed parsing: `parse-text` (Panel A), `extract-screenshots` (Panel B), `parse-vxt` (Panel C), `extract-docx`, `compress-description`, `scrub-description`, `refine-needs-review`. Largest/most-evolved file — read fully before assuming scope. |
| `/api/export` | `routes/export.js` | CSV export to Clio format (activities + expenses), validation, archiving. |
| `/api/archive` | `routes/archive.js` | List/download past export cycles (`archive_cycles` table). |
| `/api/audit` | `routes/audit.js` | Two AI audit modes: `/upload` (compare export vs AR records) and `/general` (SSE-streamed, batches large files, standalone invoice review). |

`db/database.js` owns schema + two polyfills `node:sqlite` lacks vs. `better-sqlite3`:
`lastInsertRowid` BigInt→Number normalization on `db.prepare(...).run()`, and
`db.transaction(fn)` (wraps BEGIN/COMMIT/ROLLBACK — `node:sqlite` has no native `.transaction()`).
Migrations run in an idempotent `(function migrate(){...})()` IIFE on every boot — checks
`PRAGMA table_info` and `ALTER TABLE ADD COLUMN` only if missing, safe to re-run.

## `staging_entries` schema (base columns + migrate() additions)

```
id INTEGER PK, matter TEXT, client TEXT, date TEXT (ISO YYYY-MM-DD), duration REAL,
description TEXT, category TEXT, type TEXT ('Time'|'Expense'), rate REAL, status TEXT
('Ready'|'Needs Review'|'Approved'), source TEXT, created_at TEXT,
expense_type TEXT ('HardCostEntry'|'SoftCostEntry'), vendor_name TEXT,
raw_note TEXT, needs_call_time INTEGER (0|1)
```

`raw_note` = full original note text (AI-parsed panels only), never shown to the user, used for
matter/date context. `needs_call_time` = 1 when a Panel A "Notes — Estimated" entry looks
call-shaped (`CALL_LANG_RE` match) but has no real duration yet — see merge-vxt below.

## `source` values — actually observed in `staging_entries` (sqlite query, this session)

`call_log, manual, panel_a, panel_b, quick_add, split, vxt` — observed across the May–July 2026
cycles (staging is emptied after each export, so a live count means little). **Do not assume
a source list from memory or from `public/app.js` alone**: `app.js` also branches on
`wisetime`, `cloned`, and `panel_d` (badge/UI logic for those exists) but **none of those values
have ever been persisted** in the current DB — they're legacy or forward-looking code paths, not
confirmed data shapes. The `source` column comment in `db/database.js` lists a slightly
different set (`panel_a, panel_b, wisetime, notabill, split, call_log, cloned, manual, vxt`) —
that comment is stale/aspirational too; trust the sqlite query over either the comment or the UI.

## Clio export — date format is MM/DD/YYYY, not ISO

`routes/export.js`'s `clioDate()` converts the stored ISO `YYYY-MM-DD` to Clio's bulk-import
`MM/DD/YYYY` format. **This bit a previous spec that assumed ISO passthrough.** Anything reading
or generating export CSVs must go through `clioDate()`, not format dates ad hoc.

## `routes/proc-suffix.js`

One-line shared module: `module.exports = /\s*\((split\s*entry|split|copy|clone|cloned|duplicate)\)\s*$/i`.
Strips procedural annotation suffixes (e.g. `"... (split entry)"`, `"... (copy)"`) that the AI
sometimes appends to descriptions despite prompt instructions not to. Used identically in two
places — `routes/ai.js` (`buildParsedEntries`, `sanitize` in entries.js) and `routes/export.js`
(`activityRow`/`expenseRow`) — as a single source of truth so a fix in one place can't drift from
the other. Origin/process context belongs in the `source` badge, never in `description`.

## `POST /api/entries/merge-vxt` (new this round)

Backfills real call durations onto Panel A entries the AI couldn't time. For every
`needs_call_time = 1` row, looks for `source = 'vxt'` rows sharing the same `matter` + `date`:
exactly one match → copies its `duration` in, clears the flag; zero matches → no-op; 2+ matches
→ left untouched and reported as `ambiguous` (never guessed). `description` is never touched by
the merge — the VXT row is match context only. See `docs/vxt-merge-design.md` for the full
algorithm and live-test evidence. UI: "🔗 Merge VXT Calls" button in the Staging Table header
(`public/app.js` `mergeVXT()`), renders an "Awaiting Call Time" badge on unmerged rows.

## Known Issues / Do Not

- **Panel B (screenshot capture) is still present and NOT yet deleted.** Deletion is deferred
  until VXT Import (Panel C) is trusted across a real billing cycle. Do not remove Panel B code,
  routes, or UI without asking first.
- **No hot-reload on the dev server.** It's run as plain `node server.js`, not `npm run dev`
  (which has `--watch` but isn't what's actually running). Any server-side edit (routes,
  `db/database.js`) requires manually killing and restarting the process — Round 2 hit this
  directly (a new route 404'd until restart). Check `ps aux | grep "node server.js"` first.
- `merge-vxt`'s matching is per-candidate independent — no cross-candidate consumption
  tracking, so in theory one VXT row could satisfy two different `needs_call_time` rows on the
  same matter/day. Flagged with a `// ponytail:` comment in `routes/entries.js`; acceptable
  given current data shape, upgrade only if duplicate-matching is actually observed.
- **`db/ar.db-shm` / `db/ar.db-wal` are now gitignored — never re-add them.** They used to be
  tracked, which is a genuine footgun: a `git checkout`/`pull` can drop a stale WAL next to a
  live `ar.db`, and SQLite will apply those frames as if they were current. Superseded advice in
  an earlier version of this file called committing them harmless — it isn't.
- **The dev server runs under pm2 as `valigate` on port 3002** (`npm run start:server`,
  `pm2 restart valigate` after any server-side edit). `.env` deliberately has no `PORT` line so
  pm2's `PORT=3002` wins; plain `npm start` still falls back to 3000 for throwaway dev.
- **An empty `staging_entries` is normal, not data loss.** The billing cycle is export →
  `archive_cycles` row → "Clear All". Check `archive_cycles` before ever concluding data is
  missing: after the July 2026 cycle, staging was 0 while cycles 7–9 held the exported CSVs.
