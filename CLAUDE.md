# ProBeing

A personal activity keeper: two mandatory buttons (**M**, **Prayer**), a free-text/voice
tracker, and weekly reviews. Runs on phone and laptop, always in sync.

The full staged roadmap lives in `docs/ProBeing_Execution_Plan.md`. **Current status: Stage 2
complete** (shell + sync). Stage 3 wires the M / Prayer / chip buttons.

The user is not an app developer. Explain changes in plain language, name the trade-offs, and
split any instructions into "I run this" versus "you click this in the browser".

## Architecture

```
Phone (Chrome PWA) ─┐
                    ├─► Apps Script Web App ─► Google Sheet  (source of truth)
Laptop (Chrome PWA) ─┘        (doPost)              4 tabs
```

There is no server and no database of our own. Sync is not implemented — it is a *consequence*
of both devices posting to one Apps Script deployment backed by one Sheet. Gemini (Stage 4+) is
called server-side from Apps Script, never from the browser, so its key never ships to a client.

| Path | Role |
|---|---|
| `index.html` / `styles.css` / `app.js` | the PWA, served at the repo root by GitHub Pages |
| `manifest.webmanifest` / `sw.js` | makes it installable; shell-only offline cache |
| `backend/Code.gs` | the whole API — `doPost` + an `ACTIONS` map |
| `backend/appsscript.json` | runtime + timezone (`Asia/Karachi`) + web app access |
| `scripts/make_icons.py` | regenerates `icons/` (run with `./.venv/bin/python`) |

## Non-negotiable rules

1. **POST as `text/plain`, never `application/json`.** `application/json` triggers a CORS
   preflight `OPTIONS` that Apps Script web apps cannot answer, and the request dies with an
   opaque browser error. `app.js:api()` and `Code.gs:doPost` are a matched pair — changing the
   content type on one side breaks everything.
2. **No secrets in this repo, ever.** GitHub Pages needs a *public* repo. The API URL and token
   live in `localStorage` (Settings screen); the token also lives in an Apps Script *Script
   Property* named `TOKEN`, and a local copy sits outside the repo at `~/.probeing/token.txt`.
   `.gitignore` blocks `.clasp.json`, `.clasprc.json`, and `.env*`.
3. **The Sheet wins.** If the app and the Sheet ever disagree, the Sheet is right. Never cache
   API responses in the service worker — a stale "today" is worse than a spinner.
4. **Every logging action stays under 5 seconds.** The habit is the product. If a feature adds
   taps to logging an M or a prayer, it is the wrong feature.
5. **Never render log text with `innerHTML`.** It is user input; use `textContent`.

## Data model (Google Sheet, 4 tabs)

| Tab | Columns |
|---|---|
| `Log` | timestamp, local_time, type (`work`/`status`/`M`/`prayer`/`voice`), raw_text, project, detail |
| `Prayers` | timestamp, local_time, date, prayer, mode |
| `Reports` | period, start_date, text, m_count, prayer_stats, hours_overview |
| `Now` | single row: status, last_updated |

`local_time` and `date` are additions to the original plan: the Sheet is meant to be read by a
human, and a bare ISO timestamp is not.

Prayers are `Fajr / Dhuhr / Asr / Maghrib / Isha`; modes are
`Takbeer-e-oola / Partial Jamat / Individual`. Both lists are validated server-side in `Code.gs`.

## API

Every request is `POST` with a `text/plain` body of JSON: `{action, token, ...payload}`.
Every response is JSON with an `ok` boolean.

| action | payload | does |
|---|---|---|
| `ping` | — | connectivity check (used by Settings → Test) |
| `log` | `type`, `raw_text` | append a row to `Log` |
| `m` | — | append an `M` row; returns today's count |
| `prayer` | `prayer`, `mode` | append a row to `Prayers` |
| `today` | — | today's log + prayers + m_count + now, in one round trip |
| `now_get` / `now_set` | `text` | read/write the one-line current status |
| `review` | — | stub until Stage 5 |

## Environment

Everything is project-local; nothing is installed globally or system-wide.

```bash
source ~/.nvm/nvm.sh && nvm use    # Node 22, pinned by .nvmrc
npm run serve                      # http://localhost:8080
./.venv/bin/python scripts/make_icons.py
```

`clasp` is a local devDependency — run it as `npx clasp`, never `clasp`. Note that `nvm use` is
required in each new shell before any `npm`/`npx` command.

## Deploying

- **Frontend:** `git push` to `main`. GitHub Pages serves the repo root; live within a minute.
  A hard-refresh may be needed because the service worker holds the old shell.
- **Backend:** edit `backend/Code.gs`, then `npx clasp push`, then **Deploy → Manage deployments
  → edit → New version** in the Apps Script UI. A `clasp push` alone does *not* update the live
  web app — the deployment must be re-versioned or the old code keeps serving. If clasp is not
  logged in, the fallback is pasting `Code.gs` into the browser editor; the repo stays the
  source either way.
- `setupSheet()` in `Code.gs` creates/repairs all four tabs. Safe to re-run; it never touches
  existing data.

## The stage pipeline

Each stage of the roadmap runs through four agents (`.claude/agents/`), driven by the `/stage N`
command (`.claude/skills/stage/SKILL.md`):

| Agent | Does | Cannot |
|---|---|---|
| `milestone-planner` | proves the previous stage really landed, then lists this stage's tasks and its validation checklist | write anything |
| `developer` | writes the code for the `[AGENT]` tasks | push or deploy |
| `validator` | independently tests: static, local serve, live backend, security invariants | edit anything |
| `deployer` | secret-scans, then pushes the PWA and versions the Apps Script deployment | skip the secret scan |

The tool restrictions are the design, not an oversight. A validator that could edit would patch
its own findings and always pass; a developer that could push would make the secret gate
optional. Subagents cannot call each other, so the main session carries results between them —
that is what `/stage` describes.

`/stage N` runs: plan → build → validate → fix (max 2 rounds) → deploy → report. It stops and
asks rather than looping when the second fix round still fails.

`scripts/secret_scan.sh` is the hard gate before any push: it looks for the live token, a real
`/exec` URL, tracked credential files, and Google API keys, in both the working tree and
committed history. Exit non-zero means do not push. Verify it still bites by planting the token
in a tracked file and re-running — a gate nobody has seen fail is not a gate.

## Testing

There is no test framework — this is a two-user app. Verify by hand:

```bash
curl -sL -X POST "$URL" -H 'Content-Type: text/plain' \
  -d '{"action":"ping","token":"'"$(cat ~/.probeing/token.txt)"'"}'
```

`curl` needs `-L`: Apps Script 302-redirects to `googleusercontent.com`. A stage is done only
when its validation passes on **both** phone and laptop.
