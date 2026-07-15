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
