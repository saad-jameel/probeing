# ProBeing laptop watcher (Windows)

Every 5 minutes, while you are **working** in ProBeing (not on a break, not after
End day or Sleep), this reads ActivityWatch on the laptop and sends ProBeing short
**time blocks**: from when to when, which app, which website (the site name only,
like `github.com`), which project, and what kind of time it was (work, meeting,
distraction, unclear, private).

Asleep or on a break (not after End day), it sends only **bare** blocks: from when
to when, the kind of time, and a work project if a rule named one. No app, no
site, no title, and nothing goes to Gemini. They let ProBeing ask "awake?" when
you use the laptop after Fajr while marked asleep, and "back to work?" when you
are in a work app on a break.

What never leaves the laptop: full web addresses, page text, and window titles.
The one exception: a block no rule could place sends its window title to Gemini
once, to guess the project, with links, folder paths, addresses, ids and long
numbers cut out first; only the project comes back, and the title is not stored.
It is sent only while you are working; until then it waits on the laptop, and is
dropped after 24 hours.
Terminal and file-window titles are never sent, nor the title of a browser window
the ActivityWatch extension did not see (that one is judged by its title on the
laptop, else left for you in the catch-up sheet). Anything on your private list
(banking, passwords, chats) and every incognito or InPrivate window is sent only
as "private", with no site and no title.

Nothing is installed. It is four PowerShell files and two scheduled tasks.

## Set it up (once)

You need ActivityWatch running (the icon near the clock).

1. **Copy the folder to Windows.** Open PowerShell and paste:

   ```powershell
   Copy-Item '\\wsl.localhost\Ubuntu-24.04\home\saad-wsl\proBeing\watcher\windows' "$env:USERPROFILE\ProBeing-watcher" -Recurse -Force
   ```

2. **Get the pairing line.** On the laptop, open ProBeing → Settings →
   **Laptop activity** → **Pair this laptop**. It shows one long line, **once**.
   Press **Copy**.

3. **Paste that line into PowerShell** and press Enter. It runs six steps and
   says what it did:
   - checks ActivityWatch answers,
   - runs the self test (`selftest: N ok, 0 failed` — any FAIL line means stop
     and send Claude the output),
   - asks ProBeing once ("Paired as: Laptop · …"), sending nothing,
   - only then keeps the token, encrypted for your Windows account only,
   - adds the task "ProBeing watcher", every 5 minutes while you are signed in,
   - adds the tray dot (below) and starts it.
   If one of the first five steps fails, nothing is left behind.

4. **Check it works.** Start work in ProBeing, wait 10 minutes, then open
   Settings → Laptop activity: your laptop shows "connected · last checked" with a time.

## The dot by the clock

A small coloured dot in the taskbar corner says what ProBeing thinks you are doing:

- **green** working, **amber** on a break, **blue** asleep, **grey** day over or not started
- a **red ring** round it: it cannot reach ProBeing (it tries every minute)

Hover over it: "Working on: OneNet · docker" and, underneath, today's hours,
M and prayers. Click it to open ProBeing. Right-click: Open ProBeing, Refresh
now, Quit (Quit lasts until you next sign in). It uses the watcher's pairing, so
there is nothing new to set up, and it only reads.

Windows may tuck it under the **^** arrow by the clock. Drag it out onto the
taskbar once and it stays in view.

**You already have the watcher, so add just the dot.** Open PowerShell and paste
this one line (it copies the new files over the old ones, then adds the dot):

```powershell
Copy-Item '\\wsl.localhost\Ubuntu-24.04\home\saad-wsl\proBeing\watcher\windows\*' "$env:USERPROFILE\ProBeing-watcher" -Recurse -Force; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\install.ps1" -TrayOnly
```

It runs the dot's self test (`selftest: N ok, 0 failed`), then adds the task
"ProBeing tray", which starts the dot every time you sign in. Running it again
restarts the dot; it never makes a second one.

**Remove just the dot** (the watcher keeps running):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\uninstall.ps1" -TrayOnly
```

## Day to day

- Change the distraction, meeting, private and work-apps lists, and your project
  keywords, in Settings → Laptop activity → Lists. The laptop picks them up on its
  next run. Work apps (VS Code, terminals, the Claude app, Office...) count as work
  with no project; a keyword in the window title still names the project.
- An app or site nothing sorts, used 15 minutes in a day while you are working, is
  asked about in ProBeing: "What is …?" (at most two pushes a day).
  Windows' own parts (Search, Start, the frame round Settings and Photos) are never
  asked about, and time on the lock or sign-in screen counts as away, not activity.
- "Distraction push and auto-break" in the same place turns the 10-minute push
  (and the break that follows if you ignore it) off for every device.
- When you open ProBeing it may show **"From … to … you were doing"**: change a
  block's project, or mark it as a break, then press **Looks right**. **Later**
  hides it for half an hour.

## If something looks wrong

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\watch.ps1" -Check      # what it would send now; sends nothing
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\watch.ps1" -SelfTest   # the built-in checks
Get-Content "$env:LOCALAPPDATA\ProBeing\watcher.log" -Tail 20
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\tray.ps1" -Check     # what the dot would show now
Get-Content "$env:LOCALAPPDATA\ProBeing\tray.log" -Tail 20
```

The logs have times, counts and status codes only, never titles or sites.

## Stop it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\uninstall.ps1"
```

This removes the dot too. Then Settings → Laptop activity → **Revoke** that
laptop, so its token is dead.

## Notes for whoever changes this

`watch.ps1` is a line-by-line copy of the sender half of
`supabase/functions/_shared/activity.js`, and `selftest.json` is run by both
(`claudeWorkingDocs/tests/stage18b_watcher.js` for the JavaScript). Change one,
change the other, and keep `watch.ps1` plain ASCII: Windows PowerShell 5.1 reads a
file without a BOM in the old ANSI code page.

`tray.ps1` is the same kind of pair: its colour and tooltip rules (`Tray-View`)
have a JavaScript twin in `claudeWorkingDocs/tests/item27_tray.js`, and both run
`tray_selftest.json`. It asks `activity-ingest` with `{op: 'glance'}`, which
reads the `glance` row and the state, writes nothing, and does not mark the
laptop "connected" (only the watcher should). Keep it plain ASCII too.
