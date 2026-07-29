# VXT Scrape — Reconstructed Specification

> **This is NOT the original prompt.** The actual Claude-in-Chrome recognition-logic prompt that
> produced the real scrape files referenced below was written and run in a **prior session**
> whose chat history this session does not have access to. Fabricating verbatim prompt text and
> presenting it as the original would be misleading to anyone who reads this later — so this
> document does not do that.
>
> What follows is a **reconstruction from evidence available in this session**: (1) the actual
> output of that scrape — three real markdown files produced by it, read directly for this doc —
> and (2) the one-line bullet summary of the prompt's recognition logic recorded in
> `personal-valigate-brief.md` (MA icon filtering, missed-call exclusion, duration bands, matter
> attribution, multi-client note scrubbing). It documents **observed behavior and output
> contract**, which is verifiable and arguably more durable than a guessed prompt would be — but
> it is a reconstruction, not a copy. **If the exact original wording is ever needed (e.g. to
> re-run or modify the scrape), it must be pulled from the actual prior Claude-in-Chrome
> conversation, not from this file.**

## Source files examined

Three real scrape outputs, all covering `2026-05-26` to `2026-07-14`, located in
`~/Downloads/`:

- `vxt-scrape-2026-05-26-to-2026-07-14 - Kerry.md` (63 blocks — Michael's paralegal Kerry)
- `vxt-scrape-2026-05-26-to-2026-07-14 - Ifeoma.md` (12 blocks — legal assistant Ifeoma)
- `vxt-scrape-2026-05-26-to-2026-07-14 - Farah.md` (11 blocks — legal assistant Farah)

(A fourth file, `- Farah & Ifeoma.md`, also exists in Downloads but was not read for this doc —
out of scope of the three files named for this round.)

These three files are what was actually fed into `POST /api/ai/parse-vxt` in Round 1 (79 total
entries imported, zero bugs) — see `CURRENT_STATE.md`.

## Observed output contract

### Block format

Every entry is a blank-line-separated block of exactly 5 labeled lines, in this fixed order:

```
Date: YYYY-MM-DD
Type: call | text
Duration: <decimal hours>
Client/Matter hint: <see below>
Note: <third-person recap sentence(s)>
```

This is a strict, consistent contract across all three files — no block deviates from the
5-line shape, and blank lines reliably separate blocks (matches what `routes/ai.js`'s
`parse-vxt` prompt assumes: "each blank-line-separated block is exactly one billable item").

### `Type`

Only two values observed: `call` and `text`. No other type appears.

### `Duration` — bands, not just 0.1/0.2/0.3

Short calls and texts cluster tightly at **0.1, 0.2, 0.3** — consistent with a 6-minute-increment
billing rule applied to call length or message substance. But several long *internal* calls
(Kerry ↔ Michael, unlogged/undocumented) scale well past that: **0.5, 0.6, 0.8, and 1.1** hours
appear in the Kerry file for calls whose parenthetical timestamp in the note runs 30–68 minutes
(e.g. "(1:07:35)" → `Duration: 1.1`, "(49:25)" → `Duration: 0.8`). So the duration band isn't
capped at 0.3 — it scales with actual call length, just expressed in 0.1-hour increments
throughout. The exact rounding rule (nearest vs. ceiling 6-minute increment) could not be
reverse-engineered precisely from the samples (e.g. a 16:12 call maps to `0.2`, not the `0.3` a
strict ceiling-of-6-min rule would produce) — treat the increments as confirmed, the exact
rounding formula as unconfirmed.

### Missed calls — confirmed absent

Across all 63 + 12 + 11 = 86 blocks read, **zero** represent a missed/declined/unanswered call.
Every `Type: call` block has a real duration and, where no notes were attached, a parenthetical
"(mm:ss)" figure in the Note line establishing an actual answered call took place. This matches
the claimed "missed-call exclusion" behavior — missed calls are filtered out before the markdown
is ever produced, not left in for the downstream parser to skip.

### `Client/Matter hint` — population patterns

Three distinct patterns observed:

1. **Named client, matched to a matter** — e.g. `Evans (00039)`, `Shepherd-Gore (00060)`,
   `Alfonso (00027)` in the Kerry file; `Evans (00039-Evans)`, `Alfonso (00027-Alfonso)` in the
   Farah file. **Note the format inconsistency between files**: Kerry's file gives bare
   `Surname (matter#)`, Farah's file gives `Surname (matter#-Surname)`. Both are close enough to
   the app's real matter numbers (`00039-Evans`, `00027-Alfonso`, etc. — see the seed list in
   `db/database.js`) that `parse-vxt`'s "match matter numbers... by client surname or case
   context" instruction can resolve either form, but the scrape prompt itself does not appear to
   enforce one canonical hint format across sessions/threads.
2. **Named client, no matter number** — e.g. Ifeoma file's `Client/Matter hint: Gill` and
   `Client/Matter hint: Marshall` (surname only, no `(00029)` etc.).
3. **Internal / unmatched** — `Davidson Internal`, used for firm-internal calls/texts (most of
   Kerry's internal call log with herself and Michael) and for anything the scrape couldn't tie
   to a named client (e.g. Ifeoma file: "Call to get Ifeoma started on newly assigned tasks; no
   client specified").

This 3-way pattern is consistent with the claimed "matter attribution" behavior: the scrape
attempts real matter resolution when a client name is identifiable in context, and falls back to
the firm-internal bucket rather than leaving the field blank.

### `Note` — narrated recap, not raw transcript

Every note is third-person prose summarizing the substance of the call/text, written from the
observer's perspective (referring to "MA," "Kerry," "Ms. Evans," etc.), not a verbatim transcript
or raw VXT UI text. Internal calls with no attached notes get a templated fallback: `"Internal
call between [A] and [B] (mm:ss); no notes attached."` — confirming the scrape has a
distinct-but-standard fallback rendering path for undocumented internal calls, separate from its
handling of calls with real attached notes.

### Multi-client note scrubbing — confirmed, no mixed-client blocks observed

Not one block across all 86 examined mixes two different named clients in a single Note. Where a
single real conversation plausibly touched multiple matters (e.g. the Kerry file's `2026-06-04`
block: "helped Ifeoma get up to speed identifying the DCI documents... walked her through using
Notebook LM to surface privileged-correspondence concerns Farah had flagged" — filed under
`Alfonso (00027)` only, no other client named), the note is confined to language relevant to the
one attributed matter. This matches the claimed "multi-client note scrubbing" — resolution
appears to happen once, upstream, in the scrape, rather than being left for `parse-vxt`'s own
attorney-client isolation instructions to catch downstream (though `parse-vxt` also carries that
instruction independently, as defense in depth).

## MEASURED RESULTS — the 2026-05-26 → 2026-07-14 cycle (read this first)

The scrape's output was validated against what Michael **actually invoiced**: archive cycle 7
(`archive_cycles.id = 7`, July 2026 activities, 166 entries, 64.8 hrs, $2,761, exported
2026-07-15). Matching the 79 scrape blocks against those 166 exported rows by matter+date gives
the only honest scorecard we have:

| Measure | Result |
|---|---|
| Scrape blocks that reached the invoice | **73 / 79 (92%)** — precision is good |
| Blocks dropped by hand before export | 6 (5 Davidson Internal, 1 Marshall) |
| Durations corrected by hand | 5 of 73 (all Davidson Internal; both directions, no systematic band error) |
| **Billed entries the scrape never produced** | **93 of 166 (56%)** — recall is the real problem |
| Double-billed rows across the May and July exports | **0** (verified by exact-row comparison) |

**The output quality is not the problem — the coverage is.** Three distinct causes, in order of
cost, each needing a different fix:

1. **Only internal team DMs were scraped (Kerry / Ifeoma / Farah).** Every client call and every
   third-party call was missed: litigation funders (High Rise Financial, Direct Legal Funding,
   ClaimAngel, Rockpoint), banks, opposing counsel, courts, medical providers. Evans alone
   accounted for 29 hand-entered rows, most of them funding calls. These calls *are* in VXT — they
   just aren't in a DM thread. **Fixed in V3** by defaulting coverage to the whole call log.

2. **Un-attributable calls were defaulted to `Davidson Internal`.** On days where every call came
   back labeled internal-firm, the real work turned out to be Bradley, Marshall, Gore and Alfonso
   matters that had to be re-entered by hand. Firm-internal time silently absorbed client time.
   **Fixed in V3** by making `unknown` + an `[UNATTRIBUTED]` tag the fallback, so those rows surface
   for triage instead of disappearing into 00044-Davidson.

3. **Desk work is invisible to a phone system.** Roughly a quarter of the hand-entered rows — and
   nearly all the *large* ones (1.5, 2.0, 3.0, 3.4, 4.6, 6.0 hr blocks for automation, dashboard
   work, Bates stamping, file organization, HIPAA research) — are work VXT structurally cannot see.
   **This is not fixable in the scrape and V3 explicitly tells it not to try.** That work has to
   come from the Apple Notes path (`~/Documents/Automations/Compile Work Notes.command` → Panel A).
   Judge the scrape on communications coverage only; judge total coverage on the two paths together.

**Consequence for `merge-vxt`:** cause 2 also blunts the merge feature. It matches on matter+date,
so a VXT row mis-labeled `Davidson Internal` can never match a Panel A call note filed under the
real client matter. V3's `unknown` fallback doesn't fix this by itself — an `unknown` row has no
matter to match on either. Treat merge-vxt as useful only for calls the scrape attributed
correctly, and expect the rest to stay manual until the two paths are reconciled more directly.
See `docs/vxt-merge-design.md`.

**The runnable prompt is `~/Downloads/VXT Scrape V3.md`** (V1 and V2 kept alongside it for
history). V3 folds in everything below plus the three fixes above.

## Corrections for the next scrape run

Two issues surfaced by diffing the three real output files against each other (see "Observed
output contract" above), confirmed against the actual raw call lengths embedded in the Kerry/
Ifeoma notes' parenthetical timestamps. Both are decided fixes, not open questions — apply these
as new instructions the next time the Claude-in-Chrome scrape prompt is written or re-run. Since
the original prompt text lives outside this repo (see the disclaimer at the top of this file),
these are instructions to *add*, not a diff against text this repo has access to.

### 1. `Client/Matter hint` — always `Surname (matter#)`, never bare

Kerry's file used `Surname (matter#)`, Farah's used `Surname (matter#-Surname)`, Ifeoma's
sometimes dropped the matter number entirely (bare `Gill`, `Marshall`). `parse-vxt`'s fuzzy
surname matching absorbed all three variants without error this session, but the bare-surname
form leaves zero explicit fallback if a surname is ever ambiguous across two matters. Add to the
scrape prompt:

> Whenever a client can be identified for a call or text, format the hint as exactly
> `Surname (matter#)` (e.g. `Evans (00039)`), using the matter number from the active matters
> list — never emit a bare surname with no matter number. If no matter can be confidently
> identified, use `Davidson Internal` rather than a partial or ambiguous guess.

### 2. Duration — short-call floor stays exactly as-is; everything ≥30 min becomes fully proportional

**Decision: the sub-30-minute floor bands are a deliberate minimum-increment convention and are
NOT changing** — under 6 min → 0.1 hr, 6–18 min → 0.2 hr, 19–30 min → 0.3 hr, unchanged.

What needed fixing is the ≥30-minute side, which had no documented rule at all — it happened to
come out as plain proportional rounding in the samples (34:18 → 0.6, 49:25 → 0.8, 1:07:35 → 1.1,
all matching `round(raw_minutes / 60, 1)` exactly) but nothing in the prompt guaranteed that would
reproduce reliably on the next run. Making this explicit is the actual fix. Add to the scrape
prompt:

> Duration conversion has two regimes. Under 30 minutes, use the fixed floor bands above — do not
> make these proportional. At 30 minutes or longer, floor bands stop applying entirely; instead
> round the actual elapsed call time to the nearest 0.1 hour with full proportional precision
> (e.g. a 34-minute call → 0.6 hr, a 49-minute call → 0.8 hr, a 1hr-8min call → 1.1 hr). Never
> apply a floor band to a call 30 minutes or longer.

The in-repo `extract-screenshots` prompt (`routes/ai.js`, Panel B — screenshot-based VXT capture)
carried the same undocumented gap and has already been corrected to match this same two-regime
rule directly in code, so both the external scrape and the in-repo screenshot path now apply
identical duration logic.

## Downstream contract (`routes/ai.js`, `POST /api/ai/parse-vxt`)

The ingest prompt explicitly assumes the scrape has already done the recognition work described
above — it instructs the AI: *"Do NOT re-filter missed calls or convert duration bands; the
scrape has already done that."* Each block becomes exactly one staging entry
(`source: 'vxt'`); the `Note` line becomes `raw_note`; a fresh invoice-ready `description` (≤80
chars, no timestamps/dates/duration/names) is generated from it; category is `"Notes — Timed"`
for calls, `"Text exchange"` for texts. See `CLAUDE.md` and `CURRENT_STATE.md` for how these rows
flow into the rest of the app (including the `merge-vxt` feature in
`docs/vxt-merge-design.md`, which consumes these `source: 'vxt'` rows as ground truth for
backfilling call durations onto other panels' time-less entries).
