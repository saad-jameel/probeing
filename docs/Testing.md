# Testing ProBeing

ProBeing is checked at three levels: quick static checks, hands-on checks on a real
phone and laptop, and safety checks against the live backend. A feature counts as done
only when it works on **both** phone and laptop.

## 1. Run it locally

```bash
source ~/.nvm/nvm.sh && nvm use     # Node 22, from .nvmrc
npm run serve                       # http://localhost:8080
```

Open it in Chrome. Sign-in sends you back to the address Supabase allows, so add
`http://localhost:8080` to the project's Auth redirect list if you want to sign in
locally.

## 2. Static checks (a minute)

```bash
node --check app.js && node --check sw.js && node --check supabase/functions/_shared/day.js
python3 -m json.tool manifest.webmanifest > /dev/null
```

`node --check` does not read TypeScript. For an Edge Function, copy it to a `.mts`
file and run `node --experimental-strip-types` on it: a clean file fails only on its
`jsr:` import; a broken one fails with a `SyntaxError`.

On the laptop watcher (PowerShell):

```powershell
.\watch.ps1 -SelfTest     # built-in checks, "selftest: N ok, 0 failed"
.\watch.ps1 -Check        # what it would send now; sends nothing
.\tray.ps1 -Check         # what the taskbar dot would show now
```

## 3. Hands-on checks (phone and laptop)

Do each on one device and watch the other update within a few seconds.

| Feature | Check |
|---|---|
| M | One tap adds one; the count matches on both devices. |
| Prayer | A prayer before its time is shown with its start time and cannot be picked. One logged is ticked with its mode and cannot be logged twice. The timetable shows today and tomorrow. |
| Sleep, Break, End day | Each pill changes at once. Sleep while working closes the work first. Wake after a night gives a sleep figure in Review. |
| Entries | A typed line appears in Today and, with Google connected, is filed under a task within about half an hour (or sits in Unsorted). |
| Tasks | Plan → Start → Done moves a task through Upcoming, Working on and What's done. A sub-task whose items are all closed is ticked in Google Tasks. |
| Money | An expense lowers the wallet; a void restores it; a due never moves the wallet. |
| Review | Every range shows figures at once; the written summary follows. Last week's report appears under Past reports. |
| Offline | Turn on airplane mode, press M and log a prayer, reload, turn it off: each arrives exactly once. |
| Notifications | Settings → **Send me a test push now** arrives with the app closed. |
| Watchers | After pairing, Settings shows the device with a recent "last checked". Ten minutes on a distraction while working brings a push. |
| Widget, tray dot | Both show what you are on within a few minutes of a change. |

## 4. Safety checks (live backend)

Run these with the values from your `.env` (see `.env.example`).

```bash
# Anonymous read: an empty [] is the CORRECT answer — row-level security is refusing.
curl -s "$PROBEING_SUPABASE_URL/rest/v1/events?select=id&limit=1" \
  -H "apikey: $PROBEING_SUPABASE_ANON"

# A scheduled function must refuse a caller without the cron secret: expect 401.
curl -s -X POST "$PROBEING_SUPABASE_URL/functions/v1/glance-refresh" \
  -H "Authorization: Bearer $PROBEING_SUPABASE_ANON" --data '{}'
```

Before anything is published:

```bash
bash scripts/secret_scan.sh     # must exit 0
```

It looks for live tokens, service keys, Google keys, signing keys and credential files,
in the working tree and in the whole git history. Plant a fake key in a tracked file
once and watch it fail — a gate nobody has seen fail is not a gate.

## 5. Regression suite

A larger automated suite (simulated weeks of use, the real page in a simulated browser,
the real Edge Functions against a fake backend, and a throwaway Postgres for the SQL)
is kept privately, outside this repository.
