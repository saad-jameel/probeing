# ProBeing App — Staged Execution Plan

A basic, free activity-keeper app for **mobile + laptop, always in sync**.

**Stack (all free):**
- **PWA** (HTML/CSS/JS) — one codebase, installable on Android home screen and as a desktop app in Chrome/Edge
- **Google Apps Script Web App** — backend API, runs as your Google account
- **Google Sheet** — the database and your human-readable record
- **Gemini API (free tier)** — summaries, extraction, reviews
- **Web Speech API** (built into Chrome) — free voice input, no external service
- **GitHub Pages** — free hosting for the PWA
- *(Optional last stage)* **Capacitor** — free native Android wrapper for widget / lock-screen buttons

**Why this stack:** sync is automatic (both devices hit the same Sheet), and "connect my
Google account" is mostly free — Apps Script natively reads your Google Tasks, Calendar,
and Sheets without building any OAuth flow.

---

> ## Where we actually are — audited 27 Aug 2026
>
> Verdicts below were checked against the running code and the live backends, not
> against anyone's memory. Each stage heading carries its result.
>
> | | Stage | |
> |---|---|---|
> | ✅ | 0 Foundation | done |
> | ✅ | 1 Backend API | done — but **superseded as primary** by Supabase |
> | ✅ | 2 PWA Shell + Install | done — the *sync test* is obsolete, see the stage |
> | ✅ | 3 The Buttons | done — chips were **rebuilt** as durations |
> | 🟡 | **3.5 Finish the move** | in progress — history migration **declined** (it was test data); Gemini key done; Edge Function next |
> | 🟡 | 4 Tracker + Voice | ~25% — the text box works, voice and Gemini do not exist |
> | ⬜ | 5 Review Button | shell only; the hard maths is written but only reads *today* |
> | ⬜ | 6 Weekly & Monthly Reports | not started, and has **nowhere to store a report** yet |
> | ⬜ | 7 Notifications + wrapup + offline | not started — **the 11:30 PM rules and the home-screen glance are written out in full here** |
> | ⬜ | 8 Native wrapper | not started, correctly deferred |
>
> **The plan was not followed, and that was mostly right.** A great deal was built
> that has no stage number — see *Built, but never planned* at the end. Read that
> section before assuming a gap is a gap.
>
> **Three things nobody has looked at in weeks:**
> 1. **The Gemini API key from Stage 0 step 2 was never created.** Stages 4, 5 and 6
>    all depend on it. It is two minutes of work sitting in front of half the roadmap.
> 2. **Gemini has no server-side home any more.** The whole justification for Apps
>    Script was that the key stayed on the server. With Apps Script demoted, that
>    guarantee needs a new owner — a Supabase Edge Function — or the key ends up in
>    a public repo's browser bundle.
> 3. **`Reports` has no table in `docs/supabase_schema.sql`.** Stage 6 cannot store
>    anything until it does.

## Data Model (Google Sheet, 4 tabs)

| Tab | Columns |
|---|---|
| `Log` | timestamp, type (`work` / `status` / `M` / `prayer` / `voice`), raw_text, project, detail |
| `Prayers` | timestamp, prayer (Fajr/Dhuhr/Asr/Maghrib/Isha), mode (Takbeer-e-oola / Partial Jamat / Individual) |
| `Reports` | period (week/month), start_date, text, m_count, prayer_stats, hours_overview |
| `Now` | one row: current one-line status, last_updated |

---

## ✅ Stage 0 — Foundation — DONE
**Start:** nothing exists. **Work:**
1. Create the Google Sheet with the 4 tabs.
2. Create the Apps Script project bound to it; store a random secret token + Gemini key in Script Properties.
3. Create a GitHub account/repo `probeing`; enable GitHub Pages.
4. Sketch the front page on paper: ProBeing logo, mic button, red **M** button, **Prayer** button, tracker input, **Review** button, today's log list.

**End goal (validation):** Sheet exists with correct tabs; empty page deployed at your
`github.io` URL loads on both phone and laptop.

---

## ✅ Stage 1 — Backend API (Apps Script) — DONE, superseded as primary

> **Superseded 27 Aug.** All seven actions work and the deployment still answers
> correctly — but `ping`, which touches no spreadsheet, was measured at 16.8s /
> 30.5s / 30.0s / 30.9s / 1.8s. Supabase is now the primary; Apps Script stays
> selectable in Settings as a fallback.
>
> **The `curl` test in the old docs was wrong and would mislead you:** `-X POST`
> forces the method through Apps Script's 302 and gets HTTP 405, which looks
> exactly like a dead deployment. Drop `-X POST` and let curl follow the redirect.

**Start:** empty script. **Work:** implement `doPost(e)` as a mini JSON API (every request
must carry your secret token; reject otherwise):

| action | does |
|---|---|
| `log` | append row to `Log` (type, raw_text) |
| `prayer` | append row to `Prayers` (prayer, mode) |
| `m` | append `M` row to `Log` |
| `today` | return today's rows (to display in the app) |
| `now_get` / `now_set` | read/write the `Now` line |
| `review` | (stub for Stage 5) |

Deploy as Web App ("anyone with link"; the token is your real lock).

**End goal (validation):** from laptop, `curl` each action → correct rows appear in the
Sheet; wrong token → rejected; `today` returns valid JSON of today's entries.

---

## ✅ Stage 2 — PWA Shell + Install + Sync — DONE, sync mechanism superseded

> **The sync test in this stage is now meaningless.** "Type a row into the Sheet
> and watch it appear" cannot work: the Sheet is no longer the store. Sync is
> Supabase Realtime — the database announces an insert and the app re-reads. It
> never trusts the announcement's payload, so there is exactly one code path
> that reads data.

**Start:** blank hosted page. **Work:**
1. Front page layout from your sketch: logo top, buttons, text input, today's log list below.
2. `manifest.json` (name ProBeing, icon, standalone) + minimal service worker → makes it installable.
3. Wire "today's log" list to the `today` endpoint; refresh on load and on a pull/refresh button.
4. Store the API URL + token once in the app (settings screen, saved in localStorage).

**End goal (validation):** App installs to Android home screen AND as desktop app; add a
test row directly in the Sheet → it shows in the app on both devices → sync is proven
(shared backend = sync).

---

## ✅ Stage 3 — The Buttons (M, Prayer, Quick Status) — DONE, chips superseded

> **The chips were rebuilt, deliberately.** The plan's one-tap `status` row is a
> *moment*, so "Lunch" could never become a duration and "Prayer-break" sat
> alongside a running work clock. A chip now writes the `break` edge carrying its
> reason, and the next `resume` closes it. Several can apply at once.

**Start:** static buttons. **Work:**
1. **M button:** red, prominent. Press → confirm flash → `m` action logs date+time. No
   other UI. Show today's M count subtly under it.
2. **Prayer button:** press → popup listing Fajr, Dhuhr, Asr, Maghrib, Isha; selecting one
   opens a dropdown: *Takbeer-e-oola / Partial Jamat / Individual* → Save → `prayer` action.
   Already-logged prayers today get a checkmark.
3. **Quick statuses:** small chips (Tea, Lunch, Prayer-break, Rest, PUBG…) → one tap logs a
   `status` row. Chips editable in settings.

**End goal (validation):** Press M → row in `Log` within seconds and counter increments.
Log Asr as "Partial Jamat" → correct row in `Prayers`; reopening popup shows Asr checked.
One-tap chip logs a status row. All verified from BOTH devices.

---


## ✅ Stage 3.5 — Finish the move — DONE (30 Aug 2026)

Added 27 Aug after the audit; **scope reduced 28 Aug** when Saad declined the data
migration.

### The history was NOT migrated, deliberately

The audit argued hard for importing the Sheet before building anything that reads a
date range. Saad overruled it: *"I do not want to import the history, why should I?
It was created during the testing."*

He is right, and the evidence backs him. Supabase holds 13 rows — five M presses in
seven seconds, five prayers in twenty, one `off`. The Sheet's rows are the same
shape: a fortnight of exercising buttons, not a fortnight of living. The audit's
reasoning was sound for *real* history and simply did not apply to this history.

**What this costs, recorded so nobody is surprised later:** the weekly review and the
wrapup have nothing before **27 Aug 2026**. The first genuine week starts from there.
An importer still exists in Settings if that judgement ever changes; nothing was
thrown away, the old Sheet is intact and frozen.

**What survives from the audit:** a range-reading feature must still refuse to report
on a range starting before the first row in `events`, or it will confidently announce
zero hours slept for a week that predates the database.

### Tasks

1. ~~`[USER]` Import the Log and Prayers tabs~~ — **declined, deliberately.**
2. `[USER]` Create a Gemini API key — specified in Stage 0 step 2, never done. ✅ done 28 Aug.
3. `[AGENT]` A Supabase Edge Function to hold that key server-side. The same function
   is what the nightly schedule calls, so building it once unblocks Stages 5, 6 and 7a.
   ✅ `supabase/functions/gemini/index.ts`, deployed by hand 30 Aug.
4. `[AGENT]` Add a `reports` table to `docs/supabase_schema.sql`. ✅ applied 30 Aug.
5. `[AGENT]` Stop writing to Apps Script; keep it selectable but no longer primary.
   ✅ `app.js:123` defaults `backend` to `supabase`; Apps Script stays in the picker.
6. `[USER]` Disable sign-ups. ✅ 30 Aug — `/auth/v1/signup` now answers
   `422 signup_disabled`. Not on the original list; added once it was clear that
   "signed in" meant nothing while anyone could mint an account.

### End goal (validation) — all met, 30 Aug 2026

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

### What the validation missed, and what it cost

Two bugs got through the checklist above, because both were in the *checker*.

`git log … | grep -q .` under `set -o pipefail` reported "no match" roughly three runs
in four: `grep -q` exits on its first match, `git log` dies of SIGPIPE, and 141 becomes
the pipeline's status. Three history checks were silently passing. A gate that lies
three times in four is worse than no gate, because it is trusted.

Then three checks used a bare `git grep`, which reads the working tree but not the
index — so a secret `git add`ed and then wiped from the file passed, while `git commit`
would have committed exactly that staged copy. **The gate's own file was in that state
when this was found**: the fixed script was on disk, the broken one was staged, and
every test run had been against a file that was not going to ship.

Neither was findable by reading. Both were found by planting secrets and counting
blocks. The rule this leaves behind: *a check is not verified until it has been seen
to fail.* Nine planted shapes — token, `/exec` URL, Gemini key, each on disk, staged,
and history-only — now block, twelve runs out of twelve.

## 🟡 Stage 4 — Tracker + Voice Input — PARTIAL (~25%)

> **Done:** the text tracker.
> **Not done:** voice (zero `SpeechRecognition` in the repo), Gemini extraction
> into `project`/`detail`, the echo-back of what was understood, the Gboard note.
> **Superseded:** the `Now` line. There is no such element — two always-visible
> state pills replaced it, computed from the log rather than written by an LLM.
> `now_get`/`now_set` are dead code and the `Now` tab is never written.

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

Updated 27 Aug. The original order assumed one backend and no user accounts; both
turned out to be wrong, so this is what actually blocks what.

```
  3.5 Finish the move ─┬─► 5 Review ──► 6 Reports
   (import + Gemini    │
    key + Edge Fn)     └─► 7a Wrapup ──► 7b Glance (if "notification")
                                              │
   4 Voice ─────────────(independent)         └─► 8 Native wrapper (if "real widget")

   7c Offline ──────────(independent)
```

**Why 3.5 gates so much:** Stages 5, 6 and 7a all read a *date range*. Built before
the history is in one place, each would report on half the data — and look correct
doing it, because a real number would come back.

**Why the Edge Function is in 3.5 rather than 5:** the Gemini key cannot ship to the
browser in a public repo, so it needs a server-side home. That home is one Edge
Function, and it is the same one `pg_cron` calls at 11:30 PM. Building it once
unblocks 5, 6 and 7a together.

**What is genuinely independent:** voice input (Stage 4) touches nothing else, and
offline logging (7c) only needs the `rid` scheme, which already exists.

## Voice Agent Recommendation (your question, answered plainly)
- **Mobile:** no extra agent needed — in-app Web Speech API + Gboard mic cover it. Wispr
  Flow adds nothing here.
- **Laptop:** Web Speech API in Chrome works the same; add Wispr Flow only if you want
  system-wide dictation outside ProBeing.
- **Locked phone:** no free custom hotword exists; use Stage 8's widget/notification or
  "Hey Google, open ProBeing."

## Rules
- A stage is done only when its validation passes on BOTH devices.
- The Sheet is always the source of truth — if app and Sheet ever disagree, the Sheet wins.
- Keep every logging action under 5 seconds or simplify it; the habit is the product.

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
