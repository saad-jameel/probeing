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

## Data Model (Google Sheet, 4 tabs)

| Tab | Columns |
|---|---|
| `Log` | timestamp, type (`work` / `status` / `M` / `prayer` / `voice`), raw_text, project, detail |
| `Prayers` | timestamp, prayer (Fajr/Dhuhr/Asr/Maghrib/Isha), mode (Takbeer-e-oola / Partial Jamat / Individual) |
| `Reports` | period (week/month), start_date, text, m_count, prayer_stats, hours_overview |
| `Now` | one row: current one-line status, last_updated |

---

## Stage 0 — Foundation
**Start:** nothing exists. **Work:**
1. Create the Google Sheet with the 4 tabs.
2. Create the Apps Script project bound to it; store a random secret token + Gemini key in Script Properties.
3. Create a GitHub account/repo `probeing`; enable GitHub Pages.
4. Sketch the front page on paper: ProBeing logo, mic button, red **M** button, **Prayer** button, tracker input, **Review** button, today's log list.

**End goal (validation):** Sheet exists with correct tabs; empty page deployed at your
`github.io` URL loads on both phone and laptop.

---

## Stage 1 — Backend API (Apps Script)
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

## Stage 2 — PWA Shell + Install + Sync
**Start:** blank hosted page. **Work:**
1. Front page layout from your sketch: logo top, buttons, text input, today's log list below.
2. `manifest.json` (name ProBeing, icon, standalone) + minimal service worker → makes it installable.
3. Wire "today's log" list to the `today` endpoint; refresh on load and on a pull/refresh button.
4. Store the API URL + token once in the app (settings screen, saved in localStorage).

**End goal (validation):** App installs to Android home screen AND as desktop app; add a
test row directly in the Sheet → it shows in the app on both devices → sync is proven
(shared backend = sync).

---

## Stage 3 — The Buttons (M, Prayer, Quick Status)
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

## Stage 4 — Tracker + Voice Input
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

## Stage 5 — Review Button (Weekly Overview)
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

## Stage 6 — Weekly & Monthly Reports
**Start:** on-demand review only. **Work:**
1. Time trigger Sunday (weekly) + 1st of month (monthly): compute **M count**, **prayer
   stats** (per prayer: how many, and breakdown by Takbeer-e-oola / Partial Jamat /
   Individual / missed), hours by project, learning vs other time.
2. Gemini turns it into a short report; save to `Reports` tab; app shows a "Reports" screen
   listing them (newest first).

**End goal (validation):** Sunday report exists in the tab and in the app, and its M count
and prayer breakdown exactly match a manual count of the raw rows (spot-check honesty).

---

## Stage 7 — Polish: Offline + Notifications
**Start:** works online only. **Work:**
1. Offline queue: if a log fails (no internet), keep it in localStorage and retry on
   reconnect — logging must never be lost.
2. Optional gentle nudges: Apps Script sends you an email, or (fancier) web push — skip
   push if it drags; the app is open-when-you-need-it by design.

**End goal (validation):** Airplane mode → press M and log a status → reconnect → both rows
appear in the Sheet with their original timestamps.

---

## Stage 8 (Optional) — Native Wrapper for Lock-Screen Access
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
