# Current State — Accounts Redeemable

Grounded in the actual code as of branch `vxt-validate-merge-docs` (Round 3), not a prior spec.
Where a feature has been exercised against the real running app this session (Rounds 1–2), that's
stated explicitly — everything else is "built, not live-verified this session."

## App shape

Single-page app (`public/index.html` + `public/app.js`, ~4800 lines) with 5 top-nav sections:
**Capture → Review → Export → Audit → Archive**. Backend is `server.js` + 6 route files, DB is
a single SQLite file at `db/ar.db` via `node:sqlite`. No auth, no multi-user — single-operator
local tool for attorney Michael Agege.

## 1. Capture — three-panel entry intake, plus Quick Add

The Capture section has four cards side by side: Panel A, Panel B, Panel C (VXT Import), and a
separate Activity/Expense Quick Add card (labeled "Panel C" in the HTML too — a leftover naming
quirk, not a functional issue).

- **Panel A — Manual Time Entries.** Paste raw freeform notes (any shape) or attach a `.docx`;
  `POST /api/ai/parse-text` sends the text through a large structured prompt (`routes/ai.js`)
  that identifies entry boundaries, categories, durations, matters, and applies split-entry /
  confidentiality-isolation rules for mixed client+internal notes. Tagged `source: 'panel_a'`.
  **Not live-verified this session** (was exercised only incidentally, to generate `needs_call_time`
  test rows for the merge feature in Round 2).
- **Panel B — Screenshots / Call Logs.** Upload VXT screenshot images (resized via `sharp`,
  sent to Claude vision) and/or paste call-log text; `POST /api/ai/extract-screenshots` parses
  calls (duration bands off timestamp) and texts into entries, `source: 'panel_b'`.
  **Status: still present, NOT yet deleted.** Deletion is deferred until VXT Import (Panel C) is
  trusted across a real billing cycle — see `CLAUDE.md` Known Issues. Do not remove without asking.
- **Panel C — VXT Import.** Paste the markdown output of an external VXT scrape (see
  `docs/vxt-scrape-prompt.md`) or attach a file; `POST /api/ai/parse-vxt` parses the
  already-clean, already-duration-decided blocks into entries, `source: 'vxt'`.
  **Live-verified this session (Round 1): 79 real entries imported from 3 real scrape files
  (Kerry, Ifeoma, Farah threads), zero bugs found.**
- **Activity / Expense Quick Add.** Manual form-based single-entry add, no AI involved,
  `source: 'quick_add'`. Not part of this round's testing scope; present and functional per code
  read, not separately live-verified this session.

A **Billing Period Baseline** loader (separate from the four capture panels) accepts a Clio CSV
export of entries already recorded for the current period; it's session-only (never written to
the DB) and is used purely client-side to flag staging entries with an "Already in Clio" badge
during Review — kept deliberately separate from the app's internal duplicate detection. Not
live-verified this session (pre-existing feature, out of this round's scope).

## 2. VXT / Panel A call-time merge (new, Round 2)

`POST /api/entries/merge-vxt` backfills real call durations onto Panel A "Notes — Estimated"
entries that were flagged `needs_call_time = 1` (call-shaped language, no real duration given) by
matching them against real `source: 'vxt'` rows on the same matter + date. Exactly one match →
auto-merges the duration in and clears the flag; zero matches → silently skipped; multiple matches
→ left untouched and reported back as ambiguous, never guessed. Triggered by the "🔗 Merge VXT
Calls" button in the Staging Table header; unmerged rows show an "Awaiting Call Time" badge.

**Live-verified this session (Round 2):** 5 genuine test rows created via the real Panel A AI
parser (not fabricated), 4 merged correctly (2 via curl, 2 via live UI button clicks, each
confirmed via before/after accessibility-tree reads and network response inspection), 1 correctly
left ambiguous with both real VXT candidate rows reported. Full detail and the known
simplification (no cross-candidate consumption tracking) in `docs/vxt-merge-design.md`.

## 3. Review

Staging table listing every `staging_entries` row, grouped by status (Needs Review → In Clio
Baseline → Ready → Approved), with inline editing, source badges (Panel A/B/VXT/Split/Call
Log/etc.), duplicate detection, confidentiality-risk flags, and the "Already in Clio" /
"Awaiting Call Time" badges described above. Not separately live-verified this session beyond
what the merge-vxt testing exercised incidentally.

## 4. Export

`GET /api/export/validate` and `POST /api/export/download-activities` /
`download-expenses` generate Clio bulk-import CSVs from all `Ready`/`Approved` staging rows,
split into activities (`TimeEntry`) vs. expenses (`ExpenseEntry`) with different column layouts.
Dates are converted to Clio's `MM/DD/YYYY` format (not ISO) via `clioDate()`. Every export also
writes an `archive_cycles` row (see below). Not live-verified this session — no export was run
against the real 79 VXT + merge-test rows currently sitting in staging.

## 5. Audit

Two AI-backed audit modes in `routes/audit.js`: `/upload` (compare an uploaded export against
current AR staging + archive records — duplicates, confidentiality risk, swapped columns, rate
mismatches, missing entries) and `/general` (SSE-streamed, batches large files 40 rows at a time,
standalone review of any invoice/export file on its own merits). Not exercised this session.

## 6. Archive

`archive_cycles` table stores a full CSV snapshot every time an export runs (`month_label`,
`entry_count`, `total_hours`, `total_billable`, `cycle_type`, `export_date`). The Archive section
lists past cycles and lets you re-download any prior export. Not exercised this session (no
export was run).

## Data currently in the DB (end of Round 2, unchanged this round — docs-only)

```
source     count
---------  -----
call_log   2
manual     4
panel_a    61     (7 are Round 2 live-test rows, ids 360–366)
panel_b    50
quick_add  1
split      48
vxt        79     (Round 1 real scrape import)
---------  -----
total      245
```

One row remains `needs_call_time = 1` by design: id 363 (Evans, 00039), the intentionally-left
ambiguous merge-test row with two real VXT candidates. This is expected end state, not a bug.
