# ProBeing — user guide

ProBeing keeps a record of your day — prayers, work, breaks, sleep and money — on your
phone and laptop at once, and turns it into a weekly review. Every logging tap is meant
to take under five seconds.

**Your day** starts 10 minutes before Fajr where you are (set in Settings → Prayer
times), not at midnight. Counts, prayer ticks and "today" all follow that.

## Getting started

1. Open the app in Chrome and **sign in with GitHub**.
2. Install it: Chrome's install button on the laptop; on Android, the ProBeing app (or
   Chrome ⋮ → *Add to Home screen*).
3. In **Settings** (⚙): **Turn on notifications**, **Use my location** for prayer
   times, and **Connect Google** to bring in your Google Tasks list.

Do steps 1–3 once per device. The bottom bar has five screens: Home, Today, Tasks, Money,
Review.

## Home

The two pills at the top always say where you are: **Awake / Asleep** and
**Working / On break / Day done**.

- **M** — one tap adds one. The tile shows today's count.
- **Prayer** — pick the prayer, then how you prayed it (*Takbeer-e-oola*, *Partial
  Jamat*, *Individual*), then **Save**. A prayer opens only once its time begins and
  logs once a day. **Prayer times** at the bottom of that box shows today's and
  tomorrow's timetable.
- **Sleep / Wake up** — at night it ends the day; in daylight it counts as a nap.
- **Break / Work** — pause and resume. The chips below (*Lunch*, *Coffee*…) start a
  break with that reason; **+** adds your own.
- **What are you working on?** — type a line and press **Log**. With Google connected
  it is filed under the right project and task for you. Anything it cannot place waits
  in **Unsorted** on the Tasks screen.
- **Working on** — every task running now, with its time and deadline. Per task:
  ✓ done, ⏸ pause, ✕ drop, 📌 pin (only the pinned task collects time), **+ item** to
  add a checklist item. After Done, Drop or Pause you may add a one-line note on what
  happened, or skip it.
- **Upcoming tasks** — what you planned for today. **Start** asks for priority, effort
  and an expected finish (or **Skip**). Plans from earlier days wait in **Backlog**.
- **End the day / Start the day** — closes or opens the working day without going to
  sleep.

## Today

Today's totals (worked, breaks, prayers, M, time per project) and every entry of the day,
newest first. **Refresh** re-reads it.

## Tasks

Your Google Tasks list, kept in step every 15 minutes and when you open the app.

- **Unsorted** — entries Gemini could not file. Tap the project, then the task.
- **Working on** and **Planned** — the same tasks as on Home, with Start, Done, Drop and
  Remove.
- **All tasks** — the whole list. **Plan** puts a task on today's plan; **+** on a
  project adds a sub-task (it is created in Google too). **What's done** lists finished
  and dropped tasks, with **Reopen**.

A sub-task whose items are all closed is ticked off in Google. Projects are never ticked
off for you. Dropping a task deletes it in Google; Reopen brings it back.

## Money

Amounts are in PKR.

- **Expense / Income** — type the amount, tap a tag (**New** adds one), add a note if you
  like, **Save**.
- **Left in wallet** and **per day till the 1st** count from your last wallet count.
  **Set starting amount** / **Recount** sets what is in your wallet now.
- **Dues** — who owes you and whom you owe. **Settle** records money actually moving.
- **Logs** — every entry, by day. A mistake is cancelled, never edited.
- **Buying list** — things you plan to buy this month, checked against the wallet.

## Review

Pick a range: last 2 or 7 days, this week, last week, or last 30 days.

- **Summary** — hours worked and per day, breaks, prayers (by prayer and mode, with
  missed and made-up ones), M, sleep, money in and out, and laptop/phone activity if
  you use the watchers. All of this is counted on your device.
- A few lines of **written summary** and a **Learning** line come from Gemini. If Gemini
  is unavailable you still get every figure.
- **Projects** — hours per project, grouped by kind of work. The first time a project
  appears you are asked which kind it is (Office, Personal, PhD, Personal working).
- **Past reports** — a weekly and a monthly report are written and saved when you open
  Review after a week or month ends.

## Settings

- **Bedtime notifications** — at 11:30 pm, if your day is still open, a push asks
  "still awake?". Ignore it and the day ends at that time.
- **Prayer times** — your location, calculation method and Asr school. Switches for
  prayer reminders, task-deadline reminders and a morning plan push.
- **Google Tasks** — connect, pick the list, **Sync now**. A copy of your records is
  written to a Google Sheet in your Drive daily; **Export now** does it at once.
- **Laptop and phone activity** — pair the laptop or phone, switch the distraction push
  and the sleep/break checks on or off, edit the lists (distractions, meetings, private,
  work apps, project keywords) and **Teach ProBeing** what an unsorted app is.
- **Developer settings** — the backend address, Gemini limits, and **Pair a widget**.

## Laptop watcher and taskbar dot (Windows)

Optional. It needs [ActivityWatch](https://activitywatch.net/) running. Setup steps are
in [`watcher/windows/README.md`](../watcher/windows/README.md): press **Pair this laptop**,
paste the line it gives you into PowerShell, done.

- Every 5 minutes, while you are working, it sends time blocks: app, site name,
  project, and whether it was work, a meeting, a distraction or private.
- A distraction for 10 minutes sends a push. Ignore it for 5 minutes and it becomes a
  break from when the distraction started.
- Using the laptop after Fajr while marked asleep, or a work app during a break or before
  starting the day, gets a question ("awake?", "back to work?", "start?") that records
  the right time when you answer.
- When you open ProBeing it may show **"From … to … you were doing"**: fix a block's
  project or mark it as a break, then **Looks right**.
- **The dot by the clock**: green working, amber on a break, blue asleep, grey day over;
  a red ring means it cannot reach ProBeing. Hover for today's figures; click to open
  the app.

## Phone app (Android)

The Android app is the same ProBeing, plus:

- **A home-screen widget** — what you are on and today's figures. Look-only; tap it to
  open the app. Pair it once from Settings → Developer settings → **Pair a widget**.
- **Phone activity** — the same checks as the laptop, from Android's usage access
  (which app was on screen and when; never what was on it). In Settings press **Pair
  this phone**, then **Finish in the Android app**.

## When something looks off

- The dot by the logo is green when connected. A small number beside it means taps are
  waiting on this device; they are sent, once, when the connection returns.
- The database is always right. If two devices disagree, press **Refresh** on Today.
- Settings → Developer settings → **Test** and **Test Gemini** check the connection.
