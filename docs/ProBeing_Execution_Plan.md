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
> | ⬜ | **3.5 Finish the move** | **NEW, and next.** The history is split across two databases |
> | 🟡 | 4 Tracker + Voice | ~25% — the text box works, voice and Gemini do not exist |
> | ⬜ | 5 Review Button | shell only; the hard maths is written but only reads *today* |
> | ⬜ | 6 Weekly & Monthly Reports | not started, and has **nowhere to store a report** yet |
> | ⬜ | 7 Offline + Notifications | not started — this is where the 11:30 PM wrapup lives |
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


## ⬜ Stage 3.5 — Finish the move — NEXT

Added 27 Aug, after the audit. Not in the original plan because the original plan
did not anticipate changing backends.

**Why this comes before anything else.** The history is currently split across two
databases that cannot see each other. Nothing looks broken, because "today" lives
in the new one — which is exactly why it would go unnoticed until something reads
a week and quietly reports on half the data while looking correct.

Worse, the split manufactures the orphaned events the whole toggle design exists to
prevent: a `sleep` in the Sheet whose `wake` is in Supabase is not a short night,
it is unmeasurable in both systems. Every figure in `docs/Review_Spec.md` is a
duration and needs two events.

It is also the cheapest it will ever be. The gap only grows.

**Tasks**
1. `[USER]` Export the `Log` and `Prayers` tabs as CSV and import them (Settings →
   *Bring the old Sheet across*). Rows carry a content-derived `rid`, so running it
   twice is safe.
2. `[USER]` Create a Gemini API key — specified in Stage 0 step 2, never done, and
   Stages 4, 5 and 6 all wait on it.
3. `[AGENT]` A Supabase Edge Function to hold that key server-side. The same
   function is what the nightly schedule will call, so building it once unblocks
   Stages 5, 6 and the wrapup.
4. `[AGENT]` Add a `reports` table to `docs/supabase_schema.sql`.
5. `[AGENT]` Stop writing to Apps Script once the import is verified.

**End goal (validation)**
- Row counts per `type` match between the Sheet and Supabase for every day before cutover.
- Re-running the import inserts **zero** rows.
- Every migrated `sleep` has a later `wake` and every `break` a later `resume`, or is
  listed as a known orphan. No silent unpaired events.
- Rows from before and after the cutover appear in one ordered query with no gap.
- Anonymous `insert` still returns `42501` and anonymous `select` still returns `[]` —
  the migration did not require loosening security.
- The Gemini key appears in **zero** bytes of `app.js` and `vendor/`.

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

## ⬜ Stage 7 — Polish: Offline + Notifications — NOT STARTED

> **This is where the 11:30 PM daily wrapup lives** — see `docs/Review_Spec.md`
> and the rules captured separately: compile after 9 PM, or hold until 11:30;
> notify with a Yes button; close the day effective 11:30 if unanswered.
> A real lock-screen notification needs Web Push, which Apps Script could not do
> and Supabase Edge Functions can.

**Start:** works online only. **Work:**
1. Offline queue: if a log fails (no internet), keep it in localStorage and retry on
   reconnect — logging must never be lost.
2. Optional gentle nudges: Apps Script sends you an email, or (fancier) web push — skip
   push if it drags; the app is open-when-you-need-it by design.

**End goal (validation):** Airplane mode → press M and log a status → reconnect → both rows
appear in the Sheet with their original timestamps.

---

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
```
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → (8 optional)
```
Each stage leaves the app usable. After Stage 3 you already have your two mandatory
buttons working with sync; everything after adds intelligence.

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
