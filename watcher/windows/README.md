# ProBeing laptop watcher (Windows)

Every 5 minutes, while you are **working** in ProBeing (not on a break, not after
End day or Sleep), this reads ActivityWatch on the laptop and sends ProBeing short
**time blocks**: from when to when, which app, which website (the site name only,
like `github.com`), which project, and what kind of time it was (work, meeting,
distraction, unclear, private).

What never leaves the laptop: full web addresses, page text, and window titles.
The one exception: a block no rule could place sends its window title to Gemini
once, to guess the project, with links, folder paths, addresses, ids and long
numbers cut out first; only the project comes back, and the title is not stored.
Terminal and file-window titles are never sent. Anything on your private list
(banking, passwords, chats), every incognito or InPrivate window, and any browser
window the extension did not see, is sent only as "private", with no site and no
title.

Nothing is installed. It is three PowerShell files and one scheduled task.

## Set it up (once)

You need ActivityWatch running (the icon near the clock).

1. **Copy the folder to Windows.** Open PowerShell and paste:

   ```powershell
   Copy-Item '\\wsl.localhost\Ubuntu-24.04\home\saad-wsl\proBeing\watcher\windows' "$env:USERPROFILE\ProBeing-watcher" -Recurse -Force
   ```

2. **Get the pairing line.** On the laptop, open ProBeing → Settings →
   **Laptop activity** → **Pair this laptop**. It shows one long line, **once**.
   Press **Copy**.

3. **Paste that line into PowerShell** and press Enter. It runs five steps and
   says what it did:
   - checks ActivityWatch answers,
   - runs the self test (`selftest: N ok, 0 failed` — any FAIL line means stop
     and send Claude the output),
   - asks ProBeing once ("Paired as: Laptop · …"), sending nothing,
   - only then keeps the token, encrypted for your Windows account only,
   - adds the task "ProBeing watcher", every 5 minutes while you are signed in.
   If a step fails, nothing is left behind.

4. **Check it works.** Start work in ProBeing, wait 10 minutes, then open
   Settings → Laptop activity: your laptop shows "last sent" with a time.

## Day to day

- Change the distraction, meeting and private lists, and your project keywords,
  in Settings → Laptop activity → Lists. The laptop picks them up on its next run.
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
```

The log has times and counts only, never titles or sites.

## Stop it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\ProBeing-watcher\uninstall.ps1"
```

Then Settings → Laptop activity → **Revoke** that laptop, so its token is dead.

## Notes for whoever changes this

`watch.ps1` is a line-by-line copy of the sender half of
`supabase/functions/_shared/activity.js`, and `selftest.json` is run by both
(`claudeWorkingDocs/tests/stage18b_watcher.js` for the JavaScript). Change one,
change the other, and keep `watch.ps1` plain ASCII: Windows PowerShell 5.1 reads a
file without a BOM in the old ANSI code page.
