---
name: stage
description: Run one full ProBeing stage end to end - milestone-planner checks the previous stage, developer builds, validator tests, developer fixes, deployer ships.
argument-hint: "[stage-number]"
disable-model-invocation: true
---

Run ProBeing **Stage $ARGUMENTS** through the full pipeline.

If no stage number was given, read the "Current status" line in `CLAUDE.md`, propose the next
stage, and confirm with the user before starting.

The four agents cannot talk to each other — each reports only to you. **You** carry results
from one to the next. Pass along the actual content (task lists, findings), not a summary of it.

## The loop

### 1. Plan
Spawn `milestone-planner` for Stage $ARGUMENTS.

If it reports **BLOCKED**, stop. Explain in plain language what is unfinished and what Saad
must do. Do not start building on an unverified foundation — that is the whole reason this step
exists.

If any `[USER]` tasks block progress, present them as a numbered click-list now and stop.
Never bury a blocking user task beneath agent output.

### 2. Build
Spawn `developer` with the planner's `[AGENT]` task list **verbatim**, plus its validation
checklist so the developer knows the bar it is building to.

### 3. Validate
Spawn `validator` with the planner's validation checklist and the developer's list of changed
files, including whatever the developer flagged as least confident.

### 4. Fix — at most 2 rounds
While the validator reports `[FAIL]` and fewer than 2 fix rounds have run:

- Spawn `developer` with the exact findings. Instruct it to fix **only** those.
- Spawn `validator` again to re-test.

After 2 rounds with failures still open: **stop and ask Saad.** Explain what is still broken in
plain language and what you would try next. Do not loop further — repeated failure usually
means the approach is wrong, not that another attempt is needed.

Skip to step 5 as soon as the validator reports PASS.

### 5. Ship
Spawn `deployer`. It runs the secret scan first; if that blocks, report and stop — never
override it.

### 6. Report
Close with, in this order:

1. **What now works** — in plain language, from Saad's point of view, not the code's.
2. **What Saad must do** — numbered exact click paths, or "nothing".
3. **How to check it on the phone** — the concrete thing to tap and what should happen.
4. Whether `CLAUDE.md`'s "Current status" line should be updated (only after a real pass).

## Throughout

- Say what just happened and what is next between every step, briefly. Saad is not an app
  developer; he should never have to infer state from tool output.
- Report failures plainly. A stage that did not finish is normal; a stage falsely reported as
  finished is a real problem, because it silently corrupts every later stage's foundation.
- Stages are defined in `docs/ProBeing_Execution_Plan.md`. `CLAUDE.md` holds the rules.
