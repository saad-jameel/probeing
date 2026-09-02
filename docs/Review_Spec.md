# Weekly Review — output specification

Captured from Saad, 2026-08-25. Built in **Stage 5** (on-demand review) and **Stage 6**
(scheduled weekly/monthly reports). Written down now so the data model collected in earlier
stages can actually answer it — a report can only summarise what was logged.

> **Superseded in part, 2 Sep 2026 — read this first.** Saad saw the built screen and
> changed the shape: **no paragraph.** Work is grouped under four headings he chose, each
> project shows its time, and its tasks sit under it as bullets. The current shape is at
> the end of this file. The original below is kept because the *figures* it asks for are
> still the figures, and because its dependency argument — every number is a duration, and
> a duration needs two events — is what the whole data model was built around.
>
> One consequence worth stating: almost none of the new shape is Gemini's work. Hours,
> projects and bullets are local data. Gemini writes two things now, and the review still
> costs one call.

## What the Review tab must produce — as first captured, 25 Aug

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

## The shape Saad actually asked for — 2 Sep 2026

Said after using the built screen: *"it is very good, I do not want the paragraph."*

```
This week (Mon 31 Aug – Wed 2 Sep)          ← and four other ranges

Office Projects — 21h 04m
  NeuraVue — 14h 02m
    · solving the issues of FPS throughput
    · model retraining
  OneNet — 7h 02m
    · solving the NMEA ingestion pipeline issue in the MQTT broker

PhD Working — 6h 30m
  ...

Uncategorised — 2h 10m
Unlabelled entries (12) — 9h 14m

Learning
  ...

Pace: 1-2 lines, slower or faster, with the hours named.
```

**Four headings, in his order:** Office Projects, Personal Projects, PhD Working, Personal
working (groceries and similar). Two more are not assignable and always sort last —
*Uncategorised* for a project not yet decided, and *Unlabelled entries* for the
sentence-shaped keys that were never projects at all.

**How a project gets a heading.** He asked whether to mark it in Settings or be asked while
the summary is drafted. Both, because they are one store seen from two sides: the category
is kept against the project name, the review asks about anything undecided in the range, and
Settings edits the same list when a personal project becomes office work. Skipping is always
allowed and never blocks the figures.

**Overlap is expected, and he said so first:** *"there might be total hours on the project
would be greater then the no of hours in the week because I was working parallel on the
project. So, no worries."* The groups are not normalised, and the screen says why.

**What is left for Gemini.** Only Learning and the pace line. Every hour, every project and
every bullet is computed locally by `replayDay()` and rendered directly — which is why the
numbers cannot be invented and why the redesign still costs exactly one call. The pace
comparison against the preceding period is subtracted locally too; the model is handed both
totals and the chosen word, and only phrases it.

## Open questions

- An unclosed session (forgot to press Wake) — cap it at some sane maximum, or ask?
- ~~Weekly boundary~~ — **answered 2 Sep.** "This week" is Monday → today, because a range
  including days that have not happened drags every average down. "Last week" was added for
  the previous complete Monday–Sunday, which is what a weekly review usually means.
- Monthly report: same shape, or trends versus the previous month?
- The bullet cap (`REVIEW_TASK_LINES`) currently keeps the six oldest tasks per project and
  drops the rest. Fine on today's data — four is the most any project has in a week — but it
  is silent, which is the part to decide.
