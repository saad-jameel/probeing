-- ProBeing — the whole database. Paste this into Supabase → SQL Editor → Run.
--
-- Safe to run more than once: every statement checks first, and nothing here
-- drops or rewrites data.
--
-- One table. `type` says what a row is, exactly as it did in the Sheet, so the
-- app's day-replay logic is unchanged by the move:
--   work · voice · done · M · prayer
--   sleep ↔ wake · break ↔ resume · off
-- and the columns keep their meanings: raw_text is what you typed or tapped,
-- project is the project (or the prayer name), detail is the extra field
-- (the prayer's mode, or a break's add/drop).

create extension if not exists pgcrypto;

create table if not exists public.events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,

  -- when it happened, and the same string a human could read in the old Sheet
  at          timestamptz not null default now(),
  local_time  text        not null default '',
  tz          text        not null default '',

  type        text        not null,
  raw_text    text        not null default '',
  project     text        not null default '',
  detail      text        not null default '',

  -- The client sends one id per logical write and reuses it across retries.
  -- The unique index below turns a duplicate into a harmless conflict, which
  -- is what makes a retry safe. It replaces the whole ring-buffer of recent
  -- request ids that the Apps Script backend had to keep by hand.
  rid         text,

  created_at  timestamptz not null default now()
);

-- The only query the app makes: this user's rows, newest first, for a day.
create index if not exists events_user_at_idx
  on public.events (user_id, at desc);

-- A retry cannot append twice. Partial, so rows without a rid are unaffected.
create unique index if not exists events_user_rid_idx
  on public.events (user_id, rid) where rid is not null;

-- ---------------------------------------------------------------- security
-- The anon key ships in the app and is public by design. THIS is what protects
-- the data: every row belongs to a signed-in user, and nobody can read or write
-- anyone else's. Without it the key alone would be enough to read everything.

alter table public.events enable row level security;

do $$ begin
  create policy "read own rows" on public.events
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own rows" on public.events
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Deliberately no delete policy. The log is append-only, the same as the Sheet
-- was: a mistake is corrected by a later row, never by rewriting history. Rows
-- can still be removed by hand in the Supabase table editor.
--
-- ONE EXCEPTION, AND IT IS AS NARROW AS POSTGRES CAN MAKE IT: filling in a blank
-- project name. The tracker writes your entry the instant you press Log — it
-- must, or a Break pressed a second later would be overwritten by a row that
-- landed after it — and Gemini's short name for it ("Sauda Kifyaha" out of
-- "working on Sauda Kifyaha, fixing the auth bug") arrives a few seconds behind.
--
-- IN PLAIN LANGUAGE, this is what the app can now do that it could not before:
-- on a row of YOUR OWN, of type work or voice, whose project box is still EMPTY,
-- it may write the project and detail boxes. That is all.
--   * NOT "once": while the project box is still empty the row stays writable,
--     and detail can be rewritten freely in that state. What is permanent is
--     the moment project becomes non-blank — after that the row is frozen. The
--     app only ever writes once, but the POLICY permits more, and a comment
--     about a security boundary has to describe the boundary, not the caller.
--   * `using` reads the row as it is now, so a project that has been filled in
--     can never be changed again — including back to blank.
--   * the grant below is per-COLUMN, so `raw_text`, `at`, `type` and `rid` are
--     not writable from a browser at all: what you actually typed, and when,
--     cannot be rewritten by this app or by anyone holding the public anon key.
-- The words stay exactly as you said them; only the label can be filled in.
do $$ begin
  create policy "label own unlabelled rows" on public.events
    for update
    using (auth.uid() = user_id and project = '' and type in ('work', 'voice'))
    with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Row level security picks WHICH ROWS; these two lines pick WHICH COLUMNS.
-- Supabase grants a signed-in browser update on every column by default, so the
-- blanket grant is taken away first and a two-column one put back. Re-running
-- this file is safe: revoking a privilege that is not held does nothing.
revoke update on public.events from authenticated;
grant update (project, detail) on public.events to authenticated;
-- `anon` needs no revoke: the policy above requires auth.uid() to match a row's
-- owner, and a signed-out visitor has no auth.uid() at all.

-- --------------------------------------------------------------- realtime
-- What makes the phone and the laptop update each other without a refresh.
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null; end $$;

-- ================================================================= reports
-- Where a generated review is kept once Gemini has written it. Events are what
-- happened; a report is what we made of them — derived, and re-derivable.

-- One table, not one per period. A `period` column costs nothing at roughly 400
-- rows a year, and three near-identical tables would cost a join every time.
create table if not exists public.reports (
  id           uuid        primary key default gen_random_uuid(),
  -- The default only fires for a signed-in browser. The Edge Function writes
  -- with the service_role key, where auth.uid() is NULL, so it must pass user_id
  -- itself or this not-null constraint rejects the row. That is the constraint
  -- doing its job: a report with no owner is a report nobody can read.
  user_id      uuid        not null default auth.uid() references auth.users on delete cascade,
  period       text        not null,        -- 'day' | 'week' | 'month'
  start_date   date        not null,        -- local date the span opens
  end_date     date        not null,        -- inclusive

  text         text        not null default '',              -- the Gemini prose
  -- The numbers stay numbers. The prayer breakdown is 5 prayers x 4 modes and
  -- hours-by-project is a different length every week, so flat columns would be
  -- guesswork; and Stage 6 has to check the M count against a hand count without
  -- parsing English out of the prose.
  stats        jsonb       not null default '{}'::jsonb,
  model        text        not null default '',              -- which model wrote it

  generated_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- One report per span, so regenerating overwrites instead of accumulating.
create unique index if not exists reports_user_period_start_idx
  on public.reports (user_id, period, start_date);

-- The Review screen's only query: this user's reports, newest first.
create index if not exists reports_user_start_idx
  on public.reports (user_id, start_date desc);

alter table public.reports enable row level security;

do $$ begin
  create policy "read own reports" on public.reports
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own reports" on public.reports
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- No update or delete policy for the browser, and the difference from `events`
-- is deliberate: an event is append-only because it is a fact, while a report is
-- derived and may legitimately be rebuilt. The Edge Function does that rebuild
-- with the service_role key and `on conflict do update`, which bypasses these
-- policies — so the app itself never needs the power to rewrite a report.
--
-- Stage 5 must therefore write reports like this, naming the owner explicitly,
-- because service_role has no auth.uid() to fall back on:
--
--   insert into public.reports (user_id, period, start_date, end_date, text, stats, model)
--   values ($1, 'week', $2, $3, $4, $5, $6)
--   on conflict (user_id, period, start_date)
--   do update set text = excluded.text, stats = excluded.stats,
--                 model = excluded.model, generated_at = now();

-- Deliberately NOT added to the realtime publication. A report lands around
-- 11:30 PM with the app closed; nobody is watching, and a live feed for it would
-- be a subscription that never fires.
