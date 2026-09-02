# ProBeing App — Staged Execution Plan

A basic, free activity-keeper app for **mobile + laptop, always in sync**.

**Stack (all free):**
- **PWA** (HTML/CSS/JS) — one codebase, installable on Android home screen and as a desktop app in Chrome/Edge
- **Supabase** — Postgres for the data, Auth for the sign-in, Realtime for live sync, Edge Functions for anything holding a key
- **Gemini API (free tier)** — extraction and reviews, called only from the `gemini` Edge Function
- **Web Speech API** (built into Chrome) — free voice input, no external service
- **GitHub Pages** — free hosting for the PWA
- *(Optional last stage)* **Capacitor** — free native Android wrapper for widget / lock-screen buttons
- *(Fallback, still selectable)* **Apps Script + Google Sheet** — the original backend, frozen

**This is not the stack this plan was written against**, and the difference is why
several stage descriptions below carry a "superseded" note. It said Apps Script and a
Google Sheet, chosen because both devices hitting one Sheet made sync automatic. That
backend was too slow to keep — `ping`, which touches no spreadsheet, measured 16.8s /
30.5s / 30.0s / 30.9s — and it could not push, which made live sync, the 11:30 PM
notification and the home-screen glance not merely unbuilt but impossible. The move
shipped in `f733804`; `CLAUDE.md` carries the full reasoning.

---

> ## Where things stand — 2 Sep 2026
>
> | | Stage | |
> |---|---|---|
> | ✅ | 0 Foundation | done |
> | ✅ | 1 Backend API (Apps Script) | done, **superseded as primary** by Supabase |
> | ✅ | 2 PWA Shell + Install | done; its sync *test* is obsolete — sync is Realtime now |
> | ✅ | 3 The Buttons | done; chips were **rebuilt** as durations, not moments |
> | ✅ | 3.5 Finish the move | done 30 Aug — Gemini key, Edge Function, `reports` table, sign-ups off |
> | ✅ | 4 Tracker + Voice | signed off 2 Sep — two fallback checks left untested on purpose, see the stage |
> | ⬜ | 5 Review Button | shell only; the hard maths is written but reads *today* only |
> | ⬜ | 6 Weekly & Monthly Reports | not started |
> | ⬜ | 7 Notifications + wrapup + offline | not started — the 11:30 PM rules are written out in full below |
> | ⬜ | 8 Native wrapper | not started, correctly deferred |
>
> **A great deal was built with no stage number.** Read *Built, but never planned*
> at the end before assuming a gap is a gap.

## Stages 0 to 3.5 — done, and moved out of this file

Their task lists, their validation checklists and the story of the move are in
`claudeWorkingDocs/finished-stages.md`, word for word. Nothing was cut. They were
simply the largest thing in this file and the least likely to be read again. That file
is gitignored, so a fresh clone will not have it; the same text is in this file's own
history at `git show 4b716e6:docs/ProBeing_Execution_Plan.md`. The
Google Sheet data model this plan was originally written against went with them;
`CLAUDE.md` carries both that one and the live Supabase table.

Three things they left behind that still bind every later stage:

- **Never add `-X POST` to the Apps Script `curl` test.** It forces the method
  through the 302 redirect and gets HTTP 405, which looks exactly like a dead
  deployment. This cost a real misdiagnosis.
- **There is nothing before 27 Aug 2026.** The old Sheet rows were testing data and
  Saad declined to import them, correctly. Any feature that reads a date range must
  refuse a range starting earlier rather than report a confident zero.
- **A check is not verified until it has been seen to fail.** Two bugs cleared the
  Stage 3.5 checklist because both were in the checker: `grep -q` killing `git log`
  with SIGPIPE under `set -o pipefail`, and a bare `git grep` that reads the working
  tree but not the index. Neither was findable by reading. Both were found by
  planting secrets and counting blocks.

### Stage 3.5 — End goal (validation) — all met, 30 Aug 2026

Kept here while the rest of 3.5 moved out: `milestone-planner` proves a stage landed
by walking the **previous** stage's checklist, and 3.5 is the stage before the one in
flight. Moving these bullets would leave it nothing to walk.

- ✅ The Gemini key appears in **zero** bytes of `app.js`, `index.html` and `vendor/`.
  The key was never on this machine at all: it went from Saad's screen into Supabase's
  secret store, so there was nothing for the repo to leak.
- ✅ The Edge Function refuses an unauthenticated caller — and, tested live, refuses the
  shipped **anon key** and the **service_role key** too. The anon key is a structurally
  valid project JWT that clears Supabase's own "Verify JWT", so only the role check
  stops it. That check is the whole point of the function.
- ✅ A range starting before the first row returns "No data before 2026-08-27", never a
  zero. Tested under five timezones against the real `min(at)`. No call sites yet, by
  design — Stage 5 is what will call it.
- ✅ Anonymous `insert` → `42501`; anonymous `select` → `[]`. Confirmed on `events` and
  on the new `reports` table.
- ✅ `bash scripts/secret_scan.sh` exits 0, service_role checks included.
- ✅ **End to end:** Test Gemini returned "ProBeing can reach Gemini" from the live
  function, on the real account, with the key never leaving the server.

---

## ✅ Stage 4 — Tracker + Voice Input — SIGNED OFF (2 Sep 2026)

> **Built and shipped:** the text tracker, voice input (`webkitSpeechRecognition`
> with the "ProBeing" prefix stripped, three distinct failure messages, and the
> button hidden where the API is absent), Gemini extraction into `project` and
> `tasks`, the echo-back, the Gboard note, the sub-tasks listed under each project
> heading, and the project-name vocabulary that repairs a mis-heard name.
> **Superseded:** the `Now` line. There is no such element — two always-visible
> state pills replaced it, computed from the log rather than written by an LLM.
> `now_get`/`now_set` are dead code and the `Now` tab is never written.
>
> **What is left is verification, not code**, and it is listed under "Still to
> prove" below. The distinction matters: three separate bugs this week looked
> like broken code and were a wrong limit, a stale display and an optimisation
> that had outlived its reason. None would have been found by reading.

**Start:** buttons work, no free text. **Work:**
1. Tracker input: type "working on project A, fixing auth bug" → `log` action; Gemini
   (called server-side in Apps Script) extracts `project` + `detail` columns; app echoes
   what it understood.
2. Update the `Now` line after each work log (≤12 words via Gemini) and show it under the
   logo — your "what am I doing right now."
3. **Voice:** big mic button using Web Speech API (`webkitSpeechRecognition`): tap → speak
   ("ProBeing, note I am working on project A" — the app strips the "ProBeing" prefix) →
   transcript fills the input → auto-submit after confirmation.
4. Fallback note in UI: Gboard mic on the keyboard also works anywhere the input is focused.

**End goal (validation):** Speak a work log on the phone → correct row with project/detail
filled; `Now` line updates on BOTH devices; same mic flow works on laptop Chrome.

### The end goal, checked against the rows — 2 Sep 2026

The stage's own end goal is *"speak a work log on the phone → correct row with
project/detail filled; same mic flow works on laptop Chrome."* Read straight out of
`events`, newest first, not off anyone's screen:

```
raw_text  I am working on the OneNet project and solving the NMEA ingestion
          pipeline issue in the MQTT broker. …
project   OneNet
tasks     solving the NMEA ingestion pipeline issue in the MQTT broker

raw_text  Hello I am working on the NeuraVue project and solving the issues of
          FPS throughput and model retraining.
project   NeuraVue
tasks     solving the issues of FPS throughput | model retraining
```

Dictated through Wispr Flow. **"OneNet", "NeuraVue", "NMEA" and "MQTT" all survived**
— every one of them a word the built-in recogniser had previously destroyed. The
second row split into two sub-tasks; the first correctly stayed one.

| # | What | Status |
|---|---|---|
| 1 | Sub-tasks visible under the project heading | ✅ On a device, 2 Sep |
| 2 | A typed entry on an **already-known** project getting its tasks | ✅ On a device, 2 Sep — this was the shortcut that ate them |
| 3 | A **spoken** entry producing the right project and sub-tasks | ✅ The two rows above |
| 4 | Both devices | ✅ Today's rows carry two different locale formats — `Wed 02 Sept, 11:55` and `Wed, Sep 02, 01:40 PM` — so phone and laptop both wrote and both labelled |
| 5 | Settings → **Test Gemini** reports mis-heard names repaired | ✅ Run by Saad, 2 Sep — *"yes it is changing it"* |
| 6 | Mic **blocked** → readable message naming the keyboard mic | ⬜ **Left untested, deliberately** |
| 7 | Mic **offline** → "voice needs a connection" | ⬜ **Left untested, deliberately** |

**Signed off with 6 and 7 open, and that was a decision rather than an oversight.**
Both are error messages on ProBeing's own mic button, which Saad has hidden — he
dictates through Wispr Flow. They matter on exactly one day: the day Wispr Flow's free
Android tier ends, which has no published date. Named here so that day is not the day
they are discovered.

Confirmed already: Done closes instantly on both devices; edits sync between devices
without a refresh; extraction and batching both verified through Settings → Test
Gemini.

### Hold-open dictation, added after sign-off (2 Sep)

ProBeing's own mic used to stop on its own after one sentence. It now runs until the
button is tapped a second time, which is what Saad asked for.

Not the one-line change it looks like. `continuous = true` is the whole feature on a
laptop; on Android Chrome ends the session after a few seconds of quiet whatever the
flag says. So "keep listening" is really "start another session each time one ends" —
a loop around a live microphone, which needs three guards, all of them in `app.js`
and all of them tested: a fatal error must not restart (a blocked mic retried sixty
times is sixty failures), a session that ends the instant it starts is a refusal
wearing `onend`'s clothes and three in a row stops it, and there is a two-minute
ceiling because the commonest bad ending is nobody tapping stop.

The second tap still does **not** submit. The store is append-only with no delete, and
this button is the *less* accurate mic — the one a dictation app is used instead of —
so auto-submitting here would auto-submit the path most likely to be wrong.

**41 assertions against a fake recogniser; never run on a device.** It is off Saad's
daily path (his mic button is hidden), so it is listed here rather than folded into
the sign-off above. One bug was found and fixed by the tests before shipping: the
two-minute cutoff was followed by *"Did not catch that — tap the mic and say it
again"*, which contradicts the message before it and blames the user for something the
app decided.

### A consequence of dictating outside the app: `type:'voice'` stopped meaning anything

The `voice` row type exists for one reason — so Stage 5 could answer *"how much of
this did I speak rather than type?"*. It is set when ProBeing's **own** mic fills the
box. Wispr Flow types into that box exactly like a keyboard, so the app cannot tell,
and both rows above are `type:'work'`.

Nothing is broken: `replayDay()` treats `voice` and `work` identically, so no figure
anywhere changes. But that question is now unanswerable, and it is unanswerable *going
forward* as well — it cannot be recovered later from rows that never carried the
distinction.

**Saad was asked and does not want it.** So Stage 5 drops the spoken-versus-typed
question entirely rather than carrying it as a gap. The `voice` type stays in the data
model because rows already use it and nothing is gained by rewriting history; it simply
stops being something any report asks about.

### Speech is the weak link, and it is not this app's

Android's recogniser hears **"NeuraVue" as "my review"**, **"OneNet" as "one night"**,
**"NMEA" as "anemia"** — reproduced in WhatsApp too, so it is the engine, not this
page. Chrome ignores the vocabulary hint the Web Speech API defines, so there is no
lever on the client at all: the wrong words are what the app is handed.

**What was built instead (2 Sep):** a Settings box for your project names, spelled the
way you want them. The whole list goes into the Gemini prompt — not just today's open
projects — with a rule that a phrase *sounding like* a name on the list becomes that
name. Bounded deliberately: the model may only pick a name already on the list, never
invent a correction, and `raw_text` keeps what was actually heard either way, so a
wrong match shows as a tile whose sentence plainly does not fit rather than a record
quietly rewritten.

**The rejected alternative** was to reuse the list of names the app already remembers.
It cannot work: that list only ever holds names the app has *already got right once*, so
a project speech has never transcribed correctly can never enter it — exactly the project
that needs the help.

Row 3 above checks this without spending a dictated entry: the Test Gemini probe sends a
real mangling with `NeuraVue` in a fixed vocabulary and reports whether it was repaired. A
live dictation cannot serve as that test — it costs a call, cannot be repeated
identically, and confuses "the model did not repair it" with "the microphone heard
something else this time".

---

## The Gemini budget — a standing constraint on Stages 5, 6 and 7

Learned on 30 Aug, twice, the second time correctly. The free tier for
gemini-3.6-flash allows **5 requests per minute and 20 per DAY** — read off Google's
usage dashboard (`RPM 5/5`, `TPM 375/250K`, `RPD 21/20`), not inferred. Nothing is
charged; it is a throttle. But 20 a day is a hard architectural constraint.

**The first version of this section said "20 per minute" and concluded ordinary use
could never reach it.** That was inferred from a "retry in 38s" hint in Google's
refusal, and it was wrong in the direction that matters: it dismissed a limit that
actually invalidates a design. Recorded rather than quietly edited, because the
mistake was reasoning from an error message instead of reading the meter.

**What it means:** a heavy day is 30-40 log entries. One Gemini call per entry is
30-40 calls against a ceiling of 20. **The per-entry call does not fit the free
tier.** Tokens are not the problem — 375 of 250,000 per minute were used. Requests
are. So the unit to economise is the *number of calls*, never their size: a bigger
prompt covering ten entries is free next to ten small ones.

**Bursts are the risk, and they come from one design mistake:** looping the model
over a collection. One call per day of the week is 7 at once. One call per project
is unbounded — and it is exactly what a reasonable person writes when asked for
"time per project", because it reads as the obvious decomposition.

So the rule, and it is not negotiable without measuring first:

> **A summary is ONE call.** Compute the numbers locally — `replayDay()` already
> does, over any range — and send Gemini the finished figures to put into prose.
> The model is there to write sentences, not to do arithmetic it is worse at and
> not to be asked the same question seven times.

That is also why `docs/Review_Spec.md`'s figures are computed, not asked for. If a
future stage genuinely needs several calls, space them and cap them — but the first
question is always whether one call with more context would do, and it usually will.

**Unverified and worth checking before Stage 6:** whether the free tier also caps
requests per *day*. The refusal named only the per-minute metric, so the daily
ceiling is unknown rather than known to be absent. Current usage is nowhere near
any plausible daily cap; a design that loops could be. Limits are at
https://ai.google.dev/gemini-api/docs/rate-limits and usage at https://ai.dev/rate-limit.

---

## ⬜ Stage 5 — Review Button (Weekly Overview) — NOT STARTED (shell only)

> **The hard half is already written.** `replayDay()` reconstructs a day from
> paired events — hours worked, per project, break reasons, unattributed time,
> with a guard against future timestamps. It runs client-side over **today only**.
> Stage 5 is largely generalising it to a seven-day window, plus the Gemini prose.

**Start:** data accumulates, no insight. **Work:**
1. `review` action: pull last 7 days of `Log` + `Prayers`; compute rough time-per-project
   from timestamp gaps (cap gaps at 3 hrs; exclude status breaks).
2. Gemini prompt: *"Brief overview only: projects worked on, approx time working/learning
   vs everything else. 5–6 lines max, rational, not flattering."*
3. Review button in app → shows the overview in a card.

**End goal (validation):** After a few days of real use, pressing Review returns a short
overview naming your actual projects with plausible hour splits — reads as a glance, not
an essay.

---

## ⬜ Stage 6 — Weekly & Monthly Reports — NOT STARTED

> **Blocked on a table that does not exist.** `docs/supabase_schema.sql` creates
> exactly one table, `events`. There is nowhere to put a report.
> See `docs/Review_Spec.md` for the output actually wanted — it is more specific
> than this stage.

**Start:** on-demand review only. **Work:**
1. Time trigger Sunday (weekly) + 1st of month (monthly): compute **M count**, **prayer
   stats** (per prayer: how many, and breakdown by Takbeer-e-oola / Partial Jamat /
   Individual / missed), hours by project, learning vs other time.
2. Gemini turns it into a short report; save to `Reports` tab; app shows a "Reports" screen
   listing them (newest first).

**End goal (validation):** Sunday report exists in the tab and in the app, and its M count
and prayer breakdown exactly match a manual count of the raw rows (spot-check honesty).

---

## ⬜ Stage 7 — Notifications, the daily wrapup, and offline — NOT STARTED

Rewritten 27 Aug from three requirements Saad gave verbatim and asked to have
recorded, because he expected to forget them. They are reproduced here in full;
this is the stage where they get built.

**Everything here needs Web Push, and Web Push is now easy.** It used to need
Firebase, because Apps Script cannot sign a VAPID token — its crypto library does
RSA and HMAC, and VAPID needs ES256. That constraint died with the Supabase move:
Edge Functions run Deno, whose Web Crypto signs P-256 natively. So this needs **no
Firebase and no third party**: a VAPID key pair in Supabase secrets, a
`push_subscriptions` table, one Edge Function to send, and `pg_cron` to schedule.

---

### 7a — The daily wrapup

**Compiling the day** — prayers offered, projects worked on, progress against goals:

- Day ended **after 9 PM** → compile immediately.
- Day ended **before 9 PM** → do **not** compile until 11:30 PM. He might start
  working again, and a report written at 6 PM would be wrong by bedtime.

**If the day is still open at 11:30 PM:**

1. **11:30 PM** — notify: *"are you awake?"*, with a **Yes** button and nothing else.
2. Wait **one hour** for an answer.
3. **Answered** → ask again at **01:00 AM**, same one-hour rule.
4. **Not answered** → close the day and set sleep status, **effective from the time
   the notification was sent** (11:30 PM) — *not* from when the timeout expired.

That last point is the subtle one and the easiest to get wrong. If he did not answer
at 11:30, he was asleep at 11:30; recording the day as ending at 00:30 would add an
hour of phantom wakefulness to every unanswered night.

**It must be a real notification, answerable from the lock screen.** Explicitly not an
in-app banner, explicitly not email — asked and confirmed twice. An in-app banner
fails the actual requirement, because the app is closed when he is asleep, which is
precisely when this fires.

**Depends on:** Stage 3.5 (a wrapup that reads a range must read a whole one), and a
Gemini key if the compiled summary is to be prose rather than figures.

---

### 7b — The home-screen glance

He wants, without opening the app: **Working on** (from Home) and **Today so far**
(from the Today tab).

**The honest constraint, which he has not yet ruled on.** A PWA *cannot* place a
widget on an Android home screen. The manifest's `widgets` member is Windows-only;
on a Pixel there is no supported path from an installed web app. So there are two
real options, and they are very different sizes:

| | What it is | Cost |
|---|---|---|
| **Ongoing notification** | A sticky notification the service worker keeps updated. Sits in the shade and on the lock screen, shows both figures. | Small — rides on 7a's push work |
| **A true home-screen widget** | Needs a native wrapper (TWA / Bubblewrap) and an Android widget provider. | Large — this is Stage 8 territory |

**Ask before building.** The two are not substitutes for each other and only he can
say which he meant.

---

### 7c — Offline logging

From the original plan, unchanged and still wanted: keep failed logs in a queue and
retry on reconnect, so a log made in airplane mode lands with its **original**
timestamp once signal returns.

Note this got easier too: writes already carry a `rid`, and the unique index makes a
replayed write a no-op. The queue can retry as bluntly as it likes without
duplicating anything.

**End goal (validation)**
- Airplane mode → press M and log a status → reconnect → both rows appear, with the
  timestamps from when they were pressed.
- A day left open at 11:30 PM produces a notification with a Yes button, on the lock
  screen, with the phone's screen off.
- Ignoring that notification closes the day at **23:30**, not at 00:30.
- Answering it produces a second notification at 01:00, and no report until that one
  resolves.
- A day ended at 6 PM produces no report until 11:30 PM.
- A day ended at 10 PM produces its report immediately.

## ⬜ Stage 8 (Optional) — Native Wrapper — NOT STARTED, correctly deferred
**The honest scope:** a custom always-listening "ProBeing" hotword on a locked phone is
OS-assistant territory; not buildable solo for free. The achievable versions:
1. Wrap the PWA with **Capacitor** (free) → real Android APK of the same app.
2. Add a **home-screen widget / persistent notification** with three buttons: M, Prayer,
   Mic — one tap from the lock screen opens straight into that action.
3. Set up "Hey Google, open ProBeing" (App shortcut) as the semi-hands-free path: say it,
   phone opens the app with the mic already listening (launch parameter).

**End goal (validation):** From a locked phone: one tap on the notification's M logs an M;
"Hey Google, open ProBeing" lands you in listening mode within ~3 seconds.

---

## Stage Order & Dependencies

Updated 27 Aug, and 3.5 has since cleared. The original order assumed one backend and
no user accounts; both turned out to be wrong, so this is what actually blocks what.

```
  ✅ 3.5 Finish the move ─┬─► 5 Review ──► 6 Reports
     (Gemini key +        │
      Edge Function)      └─► 7a Wrapup ──► 7b Glance (if "notification")
                                                 │
  🟡 4 Voice ─────────────(independent)          └─► 8 Native wrapper (if "real widget")

     7c Offline ──────────(independent)
```

**Nothing is blocked any more.** 3.5 landed on 30 Aug, so Stage 5 can start whenever
Stage 4 is signed off — and even that is a sequencing preference, not a dependency.

**Why 3.5 gated so much:** Stages 5, 6 and 7a all read a *date range*. Built before
the history is in one place, each would report on half the data — and look correct
doing it, because a real number would come back.

**Why the Edge Function is in 3.5 rather than 5:** the Gemini key cannot ship to the
browser in a public repo, so it needs a server-side home. That home is one Edge
Function, and it is the same one `pg_cron` calls at 11:30 PM. Building it once
unblocks 5, 6 and 7a together.

**What is genuinely independent:** voice input (Stage 4) touches nothing else, and
offline logging (7c) only needs the `rid` scheme, which already exists.

## Voice Agent Recommendation (your question, answered plainly)
**Rewritten 2 Sep 2026.** "Wispr Flow adds nothing here" was wrong. Saad installed it,
taught it "NeuraVue" and "OneNet", and it now transcribes both correctly — which is more
than the built-in recogniser has ever managed. Corrected rather than quietly edited,
because the original line would have talked him out of the thing that worked.

- **The two fixes are not alternatives, and the difference is where they act.** Wispr
  Flow fixes what the microphone *hears*. The Settings project-name list fixes what
  survives afterwards, and does a second job no dictation tool can: keeping one project
  *one* project. A perfectly transcribed "NeuraVue" can still come back from Gemini as
  "Neuravue", "Neura Vue" or "NeuraVue API" — three tiles, three rows in the weekly
  review. Feeding the known names into the prompt is what prevents that, and it predates
  the speech problem entirely. Keep both.
- **Mobile:** Wispr Flow is free and uncapped on Android — no word cap, no time cap. The
  wording is *"free + unlimited during launch"*, and **no end date is published anywhere**;
  Android launched Feb 2026, so that launch has run seven months already. Unpublished
  expiry is this project's known trap (see the Gemini budget). The closest guide to where
  it lands afterwards is the iPhone tier, 1,000 words a week — an inference, not a
  published figure. The in-app Web Speech API
  and the Gboard mic keep working when it ends, and the Settings list covers all three.
- **Laptop:** the free desktop tier is **2,000 words a week**, about twenty dictated
  entries a day. Below the volume this app is built for, and paying is out of scope. Type
  on the laptop; dictate on the phone.
- **Laptop:** Web Speech API in Chrome works the same; add Wispr Flow only if you want
  system-wide dictation outside ProBeing.
- **Locked phone:** no free custom hotword exists; use Stage 8's widget/notification or
  "Hey Google, open ProBeing."

## Rules
- A stage is done only when its validation passes on BOTH devices.
- **The store is the source of truth** — if the app and the database ever disagree, the
  database wins. This line said "the Sheet" until 2 Sep; the Sheet has not been the store
  since `f733804`, and the rule was always about the store rather than about a Sheet.
- Keep every logging action under 5 seconds or simplify it; the habit is the product.
- A summary is **one** Gemini call, with the figures computed locally by `replayDay()` and
  handed over to be put into prose. Never loop the model over days or projects.

---

## Built, but never planned

None of this has a stage number. It is most of the last week's work, and several
items exist because something in the plan turned out to be wrong.

**Backend**
- **The Supabase migration.** One `events` table replacing four Sheet tabs; prayers
  folded in with the name in `project` and the mode in `detail`. Row Level Security
  verified live in both directions — anonymous reads return nothing, anonymous
  writes are refused.
- **GitHub sign-in.** The plan assumed one shared secret and no user identity.
- **A two-backend dispatcher.** Both answer the same action names with the same
  shapes, so a bad day can be undone by flipping a setting.
- **Realtime live sync**, replacing a 45-second poll that was itself replacing
  nothing.
- **Idempotent writes**, twice: a hand-rolled ring of recent request ids in Apps
  Script, then its replacement — a unique index where a conflict *is* the success.
- **A formula-injection fix.** `appendRow` turned `"+ Tea"` into `#NAME?` and
  destroyed the text. Real data loss, found in use.

**The data model the plan did not have**
- **Three work states** (`working` / `break` / `off`) and the Sleep↔Wake,
  Break↔Resume pairs, each auto-closing the other.
- **`replayDay()`** — the day reconstructed from paired events: concurrent projects,
  overlapping totals, unattributed time, a ceiling against future timestamps.
- **Concurrent projects** with per-project Done buttons and a `done` row type.
- **Break reasons as durations**, merged by add/drop deltas so two devices cannot
  overwrite each other.
- Four extra `Log.type` values this document never listed: `sleep`, `wake`, `break`,
  `resume`, `off`, `done` — and `status` is effectively retired.

**Interface**
- A four-tab layout; the "Today so far" summary; a fourth tab that opens the user's
  own external taskboard rather than being a screen.

**Reliability, all of it a response to Apps Script's latency**
- A serialised call queue, a request timeout, retries confined to safe actions,
  optimistic rows with rollback, a capability flag so a new client never retries
  writes against an old backend that would duplicate them.

**Process**
- The four-agent stage pipeline in `.claude/agents/`, and `scripts/secret_scan.sh`
  as a hard gate before every push.
- `docs/Review_Spec.md`, capturing the weekly review output actually wanted.
- A vendored Supabase client rather than a CDN — no build step, no third party whose
  outage takes the app down.
