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

-- THE BROWSER CAN NOW UPDATE A REPORT, and this paragraph used to say the
-- opposite. It assumed an Edge Function with the service_role key would write
-- the reports, and Stage 6 established that it cannot: the gemini function
-- refuses any token whose role is not `authenticated`, and the four headings a
-- report groups work under live in the browser's own localStorage. So the app
-- writes its own reports, and rewriting one has to be allowed.
--
-- The difference from `events` is still deliberate, and is the reason this is
-- safe: an event is append-only because it is a FACT, while a report is DERIVED
-- from those facts and may legitimately be rebuilt from them. Regenerating last
-- week — say after a project has been filed under a heading — must replace that
-- week's report, not add a second one. There is still no delete policy, and no
-- per-column grant is needed here because there is no column of a report that
-- is a fact somebody typed.
do $$ begin
  create policy "update own reports" on public.reports
    for update using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- The write the app makes, in SQL. `user_id` is named explicitly even though it
-- has a default, because it is part of the conflict target; `generated_at` is
-- named because a column default only fires on an INSERT, so without it a
-- rewritten report would still be stamped with the first version's time.
--
--   insert into public.reports (user_id, period, start_date, end_date, text, stats, model)
--   values ($1, 'week', $2, $3, $4, $5, $6)
--   on conflict (user_id, period, start_date)
--   do update set text = excluded.text, stats = excluded.stats,
--                 model = excluded.model, generated_at = now();

-- Deliberately NOT added to the realtime publication. A report lands around
-- 11:30 PM with the app closed; nobody is watching, and a live feed for it would
-- be a subscription that never fires.

-- ====================================================== push notifications
-- Stage 7a. Two tables, and neither of them holds a secret of yours: one is a
-- list of postboxes the browser handed out, the other is a record of questions
-- asked at 11:30 PM and whether they were answered.

-- ------------------------------------------------------- push_subscriptions
-- WHAT A SUBSCRIPTION ACTUALLY IS: the browser goes to its own push service —
-- Google's, for Chrome — and comes back with a postbox address (`endpoint`) plus
-- two keys. Anything dropped in that postbox is delivered to this device. The
-- two keys are what encrypt the message so the push service itself cannot read
-- it, which is the only reason the wrapup's nonce can travel this way at all.
--
-- The endpoint IS the identity, so it is unique on its own rather than per user:
-- one postbox belongs to one browser, and a browser cannot hold two people's.
-- That uniqueness is also what makes the app's "subscribe again on every launch"
-- an overwrite instead of a pile of dead rows.
create table if not exists public.push_subscriptions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users on delete cascade,

  endpoint     text        not null,
  p256dh       text        not null,     -- the browser's public key
  auth         text        not null,     -- its 16-byte shared secret

  -- Which device this is, in words, for a human reading the table. There is no
  -- other way to tell the phone's row from the laptop's.
  label        text        not null default '',

  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions (endpoint);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

do $$ begin
  create policy "read own subscriptions" on public.push_subscriptions
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own subscriptions" on public.push_subscriptions
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- UNLIKE `events`, THIS TABLE IS NOT A RECORD OF ANYTHING THAT HAPPENED, so it
-- may be rewritten and deleted freely. A subscription is a current fact about a
-- device, not a fact about a day: the app re-subscribes on every launch and
-- overwrites its row (insert … on conflict (endpoint) do update), which is what
-- keeps a browser that has quietly re-issued its postbox from going silent.
-- Without the update policy that overwrite fails, and the failure looks exactly
-- like "notifications just stopped working after a few weeks".
do $$ begin
  create policy "update own subscriptions" on public.push_subscriptions
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "delete own subscriptions" on public.push_subscriptions
    for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- -------------------------------------------------------------- awake_checks
-- One row per "are you awake?" asked. It exists so the question can be a
-- DURATION rather than a moment — the day is closed as of when the question went
-- out, so something has to remember when that was, and whether an answer came.
--
-- THE NONCE IS WHY THIS TABLE HAS A COLUMN NOBODY WOULD GUESS AT. The Yes button
-- lives in a notification, which means it is pressed by a service worker, and a
-- service worker cannot read localStorage — where the Supabase session lives. So
-- it cannot prove who it is the ordinary way. Instead, 32 random bytes travel out
-- inside the encrypted push payload, addressed to one device, and coming back
-- with them is the proof. They are good for one thing: marking this one check
-- answered.
create table if not exists public.awake_checks (
  id          uuid        primary key default gen_random_uuid(),
  -- Written by the Edge Function with the service key, where auth.uid() is NULL,
  -- so the function passes user_id itself. Same trap as `reports` above.
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,

  sent_at     timestamptz not null default now(),
  local_time  text        not null default '',      -- readable, like every other table
  nonce       text        not null,

  answered_at timestamptz,                          -- null while it is still waiting

  -- "Finished with", not "answered". A check is resolved when it has been
  -- answered AND its follow-up has gone out, when the day was closed because of
  -- it, or when the day got closed some other way underneath it. Exactly one
  -- unresolved row can exist at a time, and it is what the function reads.
  resolved    boolean     not null default false,

  created_at  timestamptz not null default now()
);

create unique index if not exists awake_checks_nonce_idx
  on public.awake_checks (nonce);

-- The only query the function makes: this user's open check, newest first.
-- Partial, because resolved rows are history and are never read again.
create index if not exists awake_checks_open_idx
  on public.awake_checks (user_id, sent_at desc) where not resolved;

alter table public.awake_checks enable row level security;

-- READ-ONLY FROM A BROWSER, AND DELIBERATELY NARROWER THAN THE OTHER TABLES.
-- Nothing in the app writes a check: the Edge Function asks the question and the
-- service worker answers it with the nonce. A browser that could insert here
-- could invent a check, and one that could update could mark itself answered
-- without a notification ever arriving — which is the one thing the whole
-- mechanism is trying to establish. Select is kept so the rows can be read in
-- the app or by hand when something looks wrong.
do $$ begin
  create policy "read own checks" on public.awake_checks
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Deliberately NOT added to the realtime publication, for the same reason
-- `reports` is not: this fires at 11:30 PM with nothing on screen watching.

-- ============================================== the home-screen widget
-- Stage 8. A real box on the Android home screen, next to the app icons, showing
-- the same two lines as the notification shade.
--
-- IT IS LOOK-ONLY, by Saad's decision of 16 Sep 2026, and that decision is what
-- makes everything below small. No M button, no prayer button, no microphone on
-- the widget: tapping it opens ProBeing, and that is all it does. So the
-- credential a widget holds needs exactly one power — read two lines of text —
-- and nothing here gives `anon` a way to write a single row of anything.
--
-- THE PROBLEM THIS SOLVES: a widget is not a browser. It has no sign-in, no
-- session to keep and nowhere to keep it, so it cannot be the signed-in user the
-- way the app is. It is PAIRED instead: Settings makes a short code, shows it
-- once, and stores only its fingerprint; the widget shows that code at the door.
--
--   glance        the two lines, written by the glance-refresh Edge Function
--   device_keys   which widgets may read them
--   glance_for()  the door, and the only thing a signed-out caller may knock on

-- ----------------------------------------------------------------- glance
-- One row per person, in the same words as the notification shade. The
-- glance-refresh Edge Function writes it every 10 minutes and after each insert
-- into `events` (docs/glance_refresh.sql), using the same counting file the app
-- uses (supabase/functions/_shared/day.js), so the two cannot count differently.
-- The app no longer writes this row.
--
-- DERIVED STATE, AND FREELY REWRITTEN — the same kind of row as
-- push_subscriptions above, and the opposite of `events`. Nothing here is a fact
-- about a day; it is a copy of a sentence worked out from rows that are. Delete
-- the whole table and the cost is that the widget is blank until the next
-- refresh. That is why it is rewritten in place rather than appended to.
--
-- `as_of` IS THE HONEST PART. It is when the server computed these lines, just
-- before reading the rows. A widget that cannot say how old it is will show
-- yesterday's hours as though they were this morning's, which is the exact bug
-- Stage 7b found in the shade and fixed there the same way.
create table if not exists public.glance (
  -- Primary key, which is unique and not-null in one word, and gives the
  -- server's upsert something to conflict on. One row per person, replaced for ever.
  user_id    uuid        primary key default auth.uid() references auth.users on delete cascade,

  title      text        not null default '',   -- "Working on: NeuraVue"
  body       text        not null default '',   -- "Wed 4h 20m · 3 M · 4/5 prayers · as of 5:42 PM"
  lines      text        not null default '',   -- the widget's list of open projects, '' when none

  as_of      timestamptz not null default now(),   -- when the server computed them
  updated_at timestamptz not null default now()    -- when this row was last written
);

-- For a table made before `lines` existed; `create table if not exists` skips it.
alter table public.glance add column if not exists lines text not null default '';

alter table public.glance enable row level security;

do $$ begin
  create policy "read own glance" on public.glance
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- The server writes with the service role, which bypasses these; they remain
-- for a signed-in writer. An upsert is an insert that may turn into an update,
-- so it needs BOTH of the next two policies. With only the insert, the first write of the day succeeds
-- and every one after it fails — and it fails quietly, which would look exactly
-- like "the widget froze at breakfast time".
do $$ begin
  create policy "insert own glance" on public.glance
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "update own glance" on public.glance
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- No delete policy: nothing in the app deletes this, and revoking a widget is
-- done by removing its key below, not by emptying the line it reads.

-- ------------------------------------------------------------ device_keys
-- One row per paired widget.
--
-- WHY THE FINGERPRINT AND NOT THE CODE ITSELF. The code is a password: whatever
-- holds it can read your glance line. `secret_sha256` is a one-way fingerprint
-- of it — easy to compute from the code, impossible to run backwards — so this
-- table can recognise the right code without being able to say what any code IS.
-- Anyone who ever reads this table (a leaked backup, a stray service key, a
-- glance over your shoulder at the Supabase editor) gets 64 characters of noise
-- and no way into anything. It is the same reason a website stores a fingerprint
-- of your password instead of your password, and here it costs nothing at all:
-- the widget sends the code on every read, so nothing ever needs to remember it.
--
-- THE CODE IS THEREFORE UNRECOVERABLE ON PURPOSE. Lost it, or never wrote it
-- down? Revoke the row and pair again. Settings says exactly that at the moment
-- it shows you the code.
create table if not exists public.device_keys (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users on delete cascade,

  -- sha256 of the code with its dashes and its case taken off, as lowercase hex.
  -- pairCodeHash() in app.js builds the identical string, and glance_for() below
  -- normalises a typed-in code the same way before comparing. All three must
  -- agree or pairing silently never works.
  secret_sha256 text        not null,

  label         text        not null default '',   -- for a human reading the table
  created_at    timestamptz not null default now(),

  -- NULL until the widget's first successful read, which is the only thing that
  -- tells "paired and working" from "paired, and the code was typed in wrong".
  last_seen_at  timestamptz
);

-- Unique across EVERYBODY, not merely per person: the fingerprint is the whole
-- of the identity here, so two rows sharing one would mean a single code opening
-- two accounts. At 78.5 bits (30^16, about 4.3 x 10^23 codes) that cannot happen
-- by accident; the index is what
-- makes it a guarantee rather than an expectation.
create unique index if not exists device_keys_secret_idx
  on public.device_keys (secret_sha256);

create index if not exists device_keys_user_idx
  on public.device_keys (user_id);

alter table public.device_keys enable row level security;

do $$ begin
  create policy "read own device keys" on public.device_keys
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own device keys" on public.device_keys
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- REVOKE, FROM THE LIST IN SETTINGS. This is the one table in this file a
-- browser may delete from, and it has to be: a pairing you cannot take back is a
-- lock you cannot change. Deleting the row is what makes the code dead — there
-- is nothing else to withdraw, because nothing else was ever given out.
do $$ begin
  create policy "delete own device keys" on public.device_keys
    for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Deliberately no update policy. A pairing is not edited; it is revoked and made
-- again. The one column that does change afterwards is `last_seen_at`, and it is
-- written by the function below, which runs with its owner's rights rather than
-- the caller's.

-- ----------------------------------------------------------- glance_for()
-- THE ONLY DOOR THE WIDGET HAS, and the only thing a signed-out caller may do
-- anywhere in this database.
--
--   POST  {project URL}/rest/v1/rpc/glance_for
--   apikey: <the anon key that already ships inside app.js>
--   Content-Type: application/json
--   {"secret": "ABCD-EFGH-JKMN-PQRS"}
--
--   -> [{"title": "Working on: NeuraVue",
--        "body":  "Wed 4h 20m · 3 M · 4/5 prayers · as of 5:42 PM",
--        "lines": "Working on:\n- NeuraVue\n    - FPS jitter",
--        "as_of": "2026-09-16T12:42:00+00:00"}]
--   -> []   for any code that is not paired, and for a paired account that has
--           not written a glance line yet
--
-- `security definer` means this runs with the rights of whoever created it — you
-- — instead of the caller's. That is how a signed-out widget reads one row of a
-- table it otherwise cannot see at all, and it is a real privilege, so the body
-- is deliberately tiny and takes exactly one decision: does this code name a row.
--
-- `set search_path = ''` belongs with it and is not decoration. Without it the
-- CALLER gets to choose where the name `device_keys` is looked up, and can point
-- it at a table of their own making. So every table below is written out in full
-- as public.something. The built-ins (sha256, encode, upper …) need no such
-- spelling: pg_catalog is searched first whether or not it is named.
--
-- A WRONG CODE RETURNS NO ROWS. Not an error, and not a different error from the
-- one an unknown code gets — there is nothing to be learnt by calling this. Not
-- whether an account exists, not whether a code is half right, not how many
-- people use ProBeing. The only thing between a stranger and the glance line is
-- guessing 78.5 bits — 4.3 x 10^23 codes, which at a million guesses a second
-- takes about fourteen billion years, and Supabase would tire of the attempt
-- long before that.
--
-- WHY THE COMPARISON IS BETWEEN FINGERPRINTS. Both sides are hashed first and
-- the fixed-length digests are what get compared, so how LONG the comparison
-- takes cannot leak how much of a guessed code was right. Comparing the codes
-- themselves would stop at the first wrong character, and a patient caller can
-- read a password out of that, one character at a time. A digest gives that
-- attack nothing to hold: change one character of the code and every character
-- of the fingerprint changes with it.
--
-- Re-running this file replaces the function in place. If you ever change what
-- it RETURNS rather than what it does, Postgres will refuse — run
-- `drop function public.glance_for(text);` once, then this, and the two grants
-- at the bottom put its permissions back. docs/glance_list.sql did exactly that
-- to add `lines`, in one transaction.
create or replace function public.glance_for(secret text)
returns table (title text, body text, lines text, as_of timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  typed    text;
  key_hash text;
  owner_id uuid;
begin
  -- Typed in by a person off another screen: the dashes are there to make it
  -- readable and the capitals to make it sayable, so neither is part of the
  -- secret. normalisePairCode() in app.js strips exactly the same things before
  -- hashing, which is why a code works with the dashes or without them.
  typed := upper(regexp_replace(coalesce(secret, ''), '[^0-9A-Za-z]', '', 'g'));

  -- THE LENGTH THAT COUNTS IS THE NORMALISED ONE, and this line measured the raw
  -- argument until 16 Sep. Eight dashes therefore passed a guard that seven
  -- dashes failed — and eight dashes strip down to nothing at all, hash to the
  -- sha256 of the empty string, and would have matched a key that held that
  -- fingerprint. Nothing can store such a key (the generator only ever emits 16
  -- characters, and inserting a key at all means being signed in), so it was a
  -- defence that did not defend rather than a way in. Measured here, after the
  -- stripping, a code made of punctuation is exactly as empty as it looks.
  --
  -- 12 rather than 16, because this is a FLOOR and not the format: the generator
  -- makes 16, and pinning that number here is how a shorter code would one day
  -- be refused by a database nobody remembered to re-run.
  if length(typed) < 12 then
    return;
  end if;

  key_hash := encode(sha256(convert_to(typed, 'UTF8')), 'hex');

  -- One statement does the recognising AND the "it was used just now", so a
  -- stranger's guess writes nothing: no row matches, so no row is touched.
  update public.device_keys k
     set last_seen_at = now()
   where k.secret_sha256 = key_hash
  returning k.user_id into owner_id;

  if owner_id is null then
    return;                    -- not paired: no rows, no error, and no hint
  end if;

  return query
    select g.title, g.body, g.lines, g.as_of
      from public.glance g
     where g.user_id = owner_id;
end;
$$;

-- Postgres hands EXECUTE on a brand-new function to everybody by default, so the
-- blanket permission is taken away first and given back by name. `anon` is the
-- signed-out role the widget calls as; `authenticated` is here only so the app
-- itself could test a code without pretending to be signed out.
revoke all on function public.glance_for(text) from public;
grant execute on function public.glance_for(text) to anon, authenticated;

-- AND THAT IS THE WHOLE OF WHAT `anon` MAY DO. No table in this file grants the
-- signed-out role anything — it cannot read an event, cannot write one, cannot
-- learn that an account exists. One function, one argument, two lines of text.

-- ================================================== the schedule (pg_cron)
-- NOT RUN BY THIS FILE. It is commented out on purpose, because it carries two
-- values that must never be committed — paste it into the SQL editor with your
-- own values filled in. Everything above is safe to re-run; this is the one part
-- that is a deliberate, once-only act.
--
-- `pg_cron` and `pg_net` must be enabled first (Database → Extensions).
--
-- THE TIMES ARE IN UTC, WHICH IS NOT THE TIME THIS APP THINKS IN. The database
-- runs in UTC and Pakistan is UTC+5, so 11:30 PM in Karachi is 18:30 here. The
-- schedule below runs every ten minutes across UTC 18:00–00:59, which is
-- 11:00 PM to 6:00 AM in Karachi: early enough to catch the 11:30 check, and
-- late enough that a check sent at 4:50 AM still gets its answer an hour later.
-- Check what the database believes with:  select now();
--
-- Every ten minutes rather than once at 18:30, because the function decides for
-- itself what the time means (see shouldWrapUp) and a single fire has no second
-- chance if it lands while the push service is unreachable.
--
--   select cron.schedule('probeing-wrapup', '*/10 18-23,0 * * *', $job$
--     select net.http_post(
--       url := 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/wrapup',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         -- The public anon key, the same one in app.js. Supabase's own "Verify
--         -- JWT" gate wants a project token; it is NOT what protects this
--         -- function — the header below is.
--         'Authorization', 'Bearer <YOUR-ANON-KEY>',
--         -- ~/.probeing/cron_secret.txt. This one is a real secret.
--         'x-cron-secret', '<YOUR-CRON-SECRET>'),
--       body := '{}'::jsonb,
--       -- A cold function plus two push sends is comfortably more than pg_net's
--       -- 5-second default, and a timeout here abandons the reply to a request
--       -- that has already gone out.
--       timeout_milliseconds := 30000);
--   $job$);
--
-- To see it: select * from cron.job;
-- To see what happened:  select * from cron.job_run_details order by start_time desc limit 10;
-- To see what the function answered:
--   select created, status_code, content from net._http_response order by created desc limit 10;
-- To change it: select cron.unschedule('probeing-wrapup');  then schedule it again.
