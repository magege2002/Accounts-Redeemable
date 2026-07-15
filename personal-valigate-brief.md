# Personal Valigate (AccountsRedeemable) — Session Brief
*July 2026 | Built from: direct participation in tonight's build session (Herald-verified code reads, not assumption)*

**Supersedes:** any earlier CLAUDE.md / SPEC_GAPS.md / SESSION_BRIEF.md generated from TAR_spec.md alone, before the codebase was actually read. Those were built from a spec that turned out to be significantly behind the real app. Do not treat them as equally authoritative — this brief and a fresh CLAUDE.md built from real code are the current source of truth.

---

## Current State

Phase 2 is live and working: Node/Express/SQLite at `/Users/dafex/Claude/Accounts Redeemable`, GitHub `magege2002/Accounts-Redeemable`, `main` branch, clean. Three commits landed in tonight's session, all verified on disk via Herald, not just trusted from commit messages:

1. Export-time procedural-suffix scrub (`(copy)` and similar no longer leak onto Clio invoices — shared `proc-suffix` module used by both the parser and export).
2. `raw_note` (TEXT) and `needs_call_time` (INTEGER 0/1) columns added to `staging_entries` via idempotent migration. `raw_note` is now persisted instead of discarded. `needs_call_time` fires server-side when category is exactly `Notes — Estimated` AND call-language is detected (call, phone, spoke, talked, rang, dialed, voicemail) — this is the hook for the merge feature below.
3. New **VXT Import card** (placed between Panel B and Activity Quick Add) with `POST /api/ai/parse-vxt` endpoint. Ingests already-clean structured markdown (or .docx) and tags every resulting entry `source: 'vxt'`. Deliberately thin — no VXT recognition logic in the card itself.

Also confirmed to already exist and work, contrary to earlier assumption: the **Billing Period Baseline** feature (Audit tab) — upload a Clio CSV of already-logged entries, matching staging entries get an "Already in Clio" badge in Review. Nothing needed to be restored here.

**WiseTime decision, locked:** no automation. Manual timer-with-matter-preselect workflow replaces the planned WiseTime Playwright scrape entirely — user's own analysis showed it eliminates ~90% of reconciliation friction with fewer keystrokes than any automated alternative. Do not revisit unless the user raises it.

**VXT automation status:** Playwright MCP installed but blocked at login (VXT auth flow didn't allow it to authenticate — likely a session/cookie persistence issue, not investigated further). Pivoted to Claude in Chrome for the scrape instead. A teach-and-scrape pass was run tonight using the recognition-logic prompt (MA icon filtering, missed-call exclusion, duration bands, matter attribution, multi-client note scrubbing) documented in this project's chat history. **The output of that Claude in Chrome run has not yet been fed into the VXT Import card or validated against the expected block format.** That's the first real test of the whole pipeline.

---

## Immediate Task

Three-part session, in this order:

**1. Validate the VXT Import card against real Claude-in-Chrome output.**
Take whatever markdown the Claude in Chrome scrape produced and paste it into the VXT Import card. Confirm entries come back correctly: durations already decided, missed calls absent, multi-client calls split with confidentiality scrubbing, `source: 'vxt'` tagged. If the Claude in Chrome output doesn't match the block format `/api/ai/parse-vxt` expects (Date / Type / Duration / Client hint / Note per block), either adjust the scrape prompt or loosen the parser — don't do both blindly, diagnose which side is wrong first.

**2. Build the VXT/Panel A merge.**
Query staging entries where `needs_call_time = 1` (time-less call notes from Panel A). For each, look for a `source: 'vxt'` entry matching on matter + date (approximate time window if available). When a match is found, backfill the Panel A entry's duration from the VXT entry's real call duration, clear the `needs_call_time` flag, and leave the Panel A description intact (VXT's note is context for matching, not a replacement for the richer Panel A note). Surface ambiguous matches (multiple VXT calls same day/matter) for manual review rather than guessing.

**3. Delete screenshot Panel B, once VXT Import is proven reliable.**
Not before. The screenshot path is the fallback until the VXT Import card + merge is trusted with at least one full real billing cycle. When it's time: remove the Panel B card from `index.html`, remove `extractScreenshots()`/`handleDrop`/`attachDocxB` etc. from `app.js`, and the `/api/ai/extract-screenshots` route usage (leave the route itself if it's shared code, confirm before deleting server-side).

**4. Produce grounded docs reflecting the actual codebase.**
`TAR_spec.md` is stale in multiple places (says ISO dates, code correctly uses MM/DD/YYYY for Clio; says Panel B is client-texts-only, code has repurposed it for VXT calls/texts; doesn't mention raw_note, needs_call_time, the baseline feature, or the VXT Import card at all). Needed: a `CURRENT_STATE.md` documenting what's actually built, a corrected `CLAUDE.md` for the repo root (npm not pnpm, real schema, real source values: `panel_a, panel_b, wisetime, notabill, split, call_log, cloned, manual, vxt`), and short docs for the merge design and the VXT scrape prompt so a future session doesn't have to reconstruct tonight's reasoning from chat history.

**Acceptance criteria:**
- [ ] A real VXT scrape markdown file successfully produces correct staging entries via the VXT Import card
- [ ] At least one time-less Panel A call note gets its duration correctly backfilled from a matching VXT entry
- [ ] Panel B is either still present (if VXT Import isn't yet trusted) or fully removed with no dead code left behind
- [ ] CLAUDE.md in the repo root accurately describes the current schema, routes, and source values

---

## Locked Decisions

| Decision | Rationale |
|---|---|
| WiseTime: manual timer workflow, no automation | User's own workflow analysis showed manual is faster and lower-friction than any scrape |
| VXT: automation is worth building | High-value, no fast manual equivalent, real backlog pain (5 weeks) justified the build |
| Panel C naming = VXT Import, not a repurposed Panel B | Screenshot Panel B is vision-tuned; VXT markdown is already structured text — different tools for different inputs |
| VXT Import card stays thin | Recognition logic (missed-call exclusion, duration bands, note attribution) lives in the scrape prompt, not the ingest endpoint — one copy of the logic, at the source |
| Merge deferred until VXT data exists | Untestable without real VXT rows in staging; needs_call_time flag built first as the hook |
| `needs_call_time` is a dedicated boolean column | Cleaner querying for the merge (`WHERE needs_call_time = 1`) vs. fragile text matching |
| Export-time suffix scrub uses shared module | Single source of truth (`proc-suffix.js`) used by both parser and export, prevents future drift |
| Playwright MCP set aside for VXT scrape (for now) | Login blocker not yet resolved; Claude in Chrome used as working alternative |
| Personal Valigate stack: Node/Express/SQLite via npm | Confirmed from actual `package.json`, not assumed from spec (which implied pnpm) |
| CSV date format is MM/DD/YYYY, not ISO | Confirmed against a real Clio export upload; spec was wrong on this |

---

## Context Files Needed

| File | Why it's needed |
|---|---|
| `server.js` | Route mounting, overall app structure |
| `db/database.js` | Full schema including tonight's migrations — read the `migrate()` function directly, don't assume |
| `routes/ai.js` | All AI endpoints including `parse-text`, `parse-vxt`, `extract-screenshots`, `extract-docx`, `compress-description`, `scrub-description`, `refine-needs-review` — this is the most-evolved file in the app, always read before assuming its scope |
| `routes/entries.js` | `sanitize()`, batch insert/update — where `raw_note` and `needs_call_time` now persist |
| `routes/export.js` | CSV column mapping, the suffix-scrub fix, MM/DD/YYYY conversion |
| `public/index.html` | Card layout — note the VXT Import card sits between Panel B and Activity Quick Add |
| `public/app.js` | `parseVXT()`, `attachVXTFile()`, and the shared `attachDocx()` helper pattern all new code should follow |
| Chat history (this project, this session) | Contains the full VXT recognition-logic scrape prompt, the Billing Central context brief (VXT screenshot separation, MA icon filtering, Kerry call/notes merge logic — the deepest source material found), and the WiseTime teach instructions. Not yet written to a repo file — should be extracted into a proper doc in this session. |
| `TAR_spec.md` | Historical reference only — flag every claim against real code before trusting it |

---

## Tool Commands Relevant to This Task

```bash
# Herald project reference (already configured, confirmed clean on main)
# Project name: AccountsRedeemable
# Path: /Users/dafex/Claude/Accounts Redeemable

# Start the server locally to test the VXT Import card against real scrape output
npm start
# App at http://localhost:3000 — new DB columns auto-migrate on boot, existing entries untouched

# After any server-side change (routes/, db/)
# restart npm start manually — no PM2 on this repo, no persistent-server config yet

# Confirm current commit before starting new work
git log --oneline -5
```

---

## Open Questions for Next Session

| # | Question | Priority |
|---|---|---|
| 1 | Does the Claude-in-Chrome VXT scrape output actually match the block format `/api/ai/parse-vxt` expects (Date/Type/Duration/Client hint/Note)? Untested. | High |
| 2 | Why did Playwright MCP fail to log into VXT — session/cookie handling, 2FA, or something else? Worth a second attempt with a persistent browser context, or commit to Claude in Chrome long-term? | Medium |
| 3 | Merge matching heuristic: matter + date is the baseline plan — is that precise enough, or will same-matter/same-day multiple calls create ambiguous matches often enough to need a tighter time-window match too? | Medium |
| 4 | Exact trigger for deleting Panel B — one clean billing cycle fully on VXT Import, or a specific volume/accuracy threshold? | Low, decide when you get there |

---

## Session Decision Log

| Decision | Session | Source |
|---|---|---|
| Schema-forward surgical fixes (raw_note, needs_call_time, export scrub) scoped and built | Tonight | Chat, Herald-verified commits |
| VXT Import card built as thin ingest, recognition logic pushed to scrape prompt | Tonight | Chat, user explicitly agreed to this split |
| WiseTime automation abandoned in favor of manual timer workflow | Tonight | User's own workflow reasoning, unprompted |
| Merge intentionally deferred pending real VXT data | Tonight | Joint decision after user asked to do it same-night and agreed to sequencing |
| Baseline "Already in Clio" feature confirmed already built, not missing | Tonight | Herald file read of `public/index.html`, corrected earlier wrong assumption |
