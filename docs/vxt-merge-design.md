# VXT / Panel A Call-Time Merge — Design

Describes `POST /api/entries/merge-vxt` (`routes/entries.js`, added Round 2, commit `c90063a`)
as actually implemented — read directly from the code, not from what was originally planned.

## Problem it solves

Panel A's AI parser (`routes/ai.js`, `parse-text`) sometimes encounters a note that's clearly
about a call — someone talked to a client, no duration was written down — but the prompt's
call-language detector (`CALL_LANG_RE = /call|phone|spoke|talked|rang|dialed|voicemail/i`) fires
on `category === 'Notes — Estimated'` entries, and `buildParsedEntries()` sets
`needs_call_time = 1` on the resulting row. That row gets a real duration guess (`needsReview`
estimate) but no ground truth. Separately, VXT Import (Panel C) produces `source: 'vxt'` rows
with real, scrape-derived call durations for the same matter/date. The merge endpoint reconciles
the two: pulls the VXT duration onto the time-less Panel A row wherever it can do so unambiguously.

## Algorithm (as implemented)

```js
router.post('/merge-vxt', (req, res) => {
  const merge = db.transaction(() => {
    const candidates = db.prepare(
      'SELECT * FROM staging_entries WHERE needs_call_time = 1'
    ).all();
    const matchStmt = db.prepare(
      "SELECT * FROM staging_entries WHERE source = 'vxt' AND matter = ? AND date = ? AND needs_call_time = 0"
    );
    const updateStmt = db.prepare(
      'UPDATE staging_entries SET duration = ?, needs_call_time = 0 WHERE id = ?'
    );
    const merged = [];
    const ambiguous = [];
    for (const candidate of candidates) {
      const matches = matchStmt.all(candidate.matter, candidate.date);
      if (matches.length === 1) {
        updateStmt.run(matches[0].duration, candidate.id);
        merged.push({ id: candidate.id, duration: matches[0].duration });
      } else if (matches.length > 1) {
        ambiguous.push({ entry: candidate, candidates: matches });
      }
      // zero matches: no-op, not reported
    }
    return { merged, ambiguous };
  });
  res.json(merge());
});
```

Whole thing runs in one `db.transaction()` (the `node:sqlite` polyfill in `db/database.js` —
BEGIN/COMMIT/ROLLBACK wrapper).

### Matching key

**Matter + date, exact string equality, plus `needs_call_time = 0` on the VXT side.** Both matter
and date columns are plain `TEXT` (matter is the human matter number like `00039-Evans`, date is
`YYYY-MM-DD`). No fuzzy matching, no time-of-day component, no client-name fallback.

The `needs_call_time = 0` filter on the match query is load-bearing, not incidental — it was added
after an end-of-run adversarial review caught that `buildParsedEntries()` (`routes/ai.js`) can set
`needs_call_time = 1` on `source: 'vxt'` rows too (a scraped call block with no duration still
reads as call-language). Without the filter, a `source: 'vxt'` candidate with no other VXT row on
its matter/date would match *itself* — silently "merging" against its own unchanged duration and
clearing its own flag, which looks like a resolved entry but never received any real corroborating
data. The filter also prevents an unconfirmed VXT estimate from ever getting pulled onto a Panel A
row as if it were scrape-derived ground truth. Verified live post-fix: a synthetic
`source:'vxt', needs_call_time:1` row with a unique matter/date came back in neither `merged` nor
`ambiguous` — correctly a silent no-op.

### Exactly-one-match → auto-merge

The candidate's `duration` is overwritten with the single VXT match's `duration`, and
`needs_call_time` is cleared to `0`. Nothing else on the row changes.

### Zero-match → silent no-op

If no `source: 'vxt'` row shares the candidate's matter+date, the candidate is left completely
untouched and does **not** appear in either `merged` or `ambiguous` in the response. This is
deliberate — there's nothing to report; the row simply stays `needs_call_time = 1` until either a
matching VXT entry shows up in a future import, or a human resolves it manually.

### Multi-match → ambiguous, never guessed

If two or more `source: 'vxt'` rows share the candidate's matter+date, the endpoint makes no
attempt to pick one. The candidate is left untouched (`needs_call_time` stays `1`, duration
unchanged) and the full candidate row plus every matching VXT row is pushed into `ambiguous`, so
a human can resolve it by inspecting the actual call notes. Real example from Round 2 live
testing — id 363 (`00039-Evans`, `2026-05-27`), where the raw JSON response was:

```json
{"merged":[{"id":364,"duration":0.3}],
 "ambiguous":[{"entry":{"id":363,"matter":"00039-Evans","date":"2026-05-27",...},
               "candidates":[{"id":282,...},{"id":311,...}]}]}
```

### Description-preservation rule

The `UPDATE` statement only ever touches `duration` and `needs_call_time`. The candidate's
`description`, `raw_note`, `category`, everything else is left exactly as the Panel A AI parser
originally produced it. This was an explicit product decision, not an oversight: the matching
VXT row's note is treated purely as corroborating context for finding the right duration — it is
never used to overwrite or append to the invoice-facing description the attorney already wrote
(or the AI already generated) for that entry.

## Known simplification (marked in code)

`routes/entries.js` carries this comment directly above the match loop:

```js
// ponytail: per-candidate independent matching, no cross-candidate consumption-tracking —
// the same VXT entry could satisfy two different time-less Panel A rows on the same
// matter/day. Acceptable given current data shape; upgrade only if duplicate-matching
// is actually observed in practice.
```

Concretely: each `needs_call_time = 1` candidate runs its own independent `matchStmt` query
against the full VXT set. There is no bookkeeping that removes a VXT row from the pool once it's
been used to merge one candidate. If matter X had two Panel A rows both missing call time on the
same date, and only one VXT call happened that day on that matter, both candidates would see
exactly one match (the same VXT row) and both would auto-merge to the same duration — silently
double-counting that one real call. The upgrade path (if this is ever observed in real data) is
to remove/mark a VXT row as consumed after a successful single-match merge, or to widen the
match set to look at duration/description similarity when there are 2+ needs_call_time rows on
the same matter/day. Not built, because it's never been observed in the 79 real VXT rows plus
7 real Round 2 test rows exercised so far.

## Live-test evidence (Round 2, this session-family — see handoff.md for full detail)

Tested against the real running app (`localhost:3000`), not mocked. Five genuine
`needs_call_time = 1` rows were created by actually running notes through the real Panel A AI
parser (worded to avoid the literal word "call" so the classifier would land on
`"Notes — Estimated"` rather than defaulting to `"Phone call"` — a quirk noted during testing,
not a bug in merge-vxt itself):

- id 362 (`00029-Gill`, `2026-07-06`) — 1 VXT match → merged, duration 0.2→0.3. Confirmed via
  curl + accessibility-tree read before/after.
- id 363 (`00039-Evans`, `2026-05-27`) — 2 VXT matches (ids 282, 311) → correctly left
  untouched, reported in `ambiguous` with both candidates. Confirmed via the raw network
  response (exact JSON shape above).
- id 364 (`00027-Alfonso`, `2026-06-02`) — 1 VXT match → merged via a live UI button click,
  duration 0.3, badge disappeared, confirmed in accessibility tree.
- id 365 (`00044-Davidson`, `2026-06-05`) — 1 VXT match → merged via a second live UI click,
  duration correctly backfilled to 0.1.
- id 366 (`00027-Alfonso`, `2026-06-04`) — 1 VXT match → merged via a third live UI click.

Result: single-match auto-merge confirmed twice via curl/UI with before/after verification;
multi-match ambiguous path confirmed once with the definitive raw response payload above (proves
it never guesses and reports both real candidates). Zero-match path was not separately exercised
with a dedicated test row this session, but is a straightforward `matches.length === 0` no-op
branch with no side effects to verify beyond "nothing happens," which the absence of any
unexpected row changes across all testing implicitly confirms.
