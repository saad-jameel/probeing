# Weekly Review — output specification

Captured from Saad, 2026-08-25. Built in **Stage 5** (on-demand review) and **Stage 6**
(scheduled weekly/monthly reports). Written down now so the data model collected in earlier
stages can actually answer it — a report can only summarise what was logged.

## What the Review tab must produce

Not raw rows. A short, Gemini-written summary in Saad's own framing — "what I did last week":

```
Last week (Mon 18 Aug – Sun 24 Aug)

You worked 41 hours, averaging 5.9 hours per day.
Average sleep 6.4 hours per day.
Out with friends 7 hours across 2 days.

Projects
  OneNet      18h   PKI certs, broker mTLS, node heartbeat
  Neuravue    12h   docker fixes, backend features
  ProBeing     8h   stage 3 buttons, prayer picker
  Other        3h

Learning
  Apps Script deployment model, PWA service workers, mTLS basics
```

Tone rule from the plan doc: *"Brief overview only… 5–6 lines max, rational, not flattering."*
The shape above is the target; Gemini fills it, and must not editorialise or praise.

## What each figure needs from the data model

| Figure | Comes from | Status |
|---|---|---|
| hours worked, avg/day | `Break/Work` toggle pairs in `Log` | needs the work/break state rows |
| avg sleep per day | `Sleep`/`Wake` toggle pairs in `Log` | needs the sleep/wake state rows |
| out with friends | a status chip, or a project tagged personal | inferred from chips/projects |
| hours per project | `project` column on `work` rows | **needs the project picker (next round)** |
| what was done per project | `detail` column, summarised by Gemini | needs Gemini extraction |
| skills learned | Gemini inference over `detail` text | needs Gemini |

**The dependency worth stating plainly:** every number above is a *duration*, and durations come
from paired events (sleep→wake, work→break). A lone event with no closing partner cannot be
measured. This is why the Sleep/Wake and Break/Work toggles matter more than they look — they
are what makes the weekly review possible at all. The plan doc's fallback of estimating from
timestamp gaps (capped at 3 hours) stays as a backstop for unpaired days.

## Open questions for Stage 5

- An unclosed session (forgot to press Wake) — cap it at some sane maximum, or ask?
- Weekly boundary: Monday–Sunday, or the plan doc's Sunday trigger?
- Monthly report: same shape, or trends versus the previous month?
