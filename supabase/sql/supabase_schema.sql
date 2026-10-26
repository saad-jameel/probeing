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
-- into `events` (supabase/sql/glance_refresh.sql), using the same counting file the app
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
-- at the bottom put its permissions back. supabase/sql/glance_list.sql did exactly that
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

-- ---------------------------------------------------------- user_settings
-- Stage 10. Where his prayer times are worked out, and his time zone, so the
-- Edge Functions (glance-refresh, wrapup) count the same day as his device: the
-- day turns 10 minutes before Fajr at this place. One row per person, written by
-- the app from Settings; the functions read it with the service role and fall
-- back to Karachi (24.8607, 67.0011, Asia/Karachi) when there is no row.
--
-- lat/lng are null until "Use my location" is pressed, and the zone is written
-- only together with them, by the device that measured them — a device with no
-- location of its own never writes either, so it cannot erase or flip them. `method` and `asr_school` are the keys
-- of PRAYER_METHODS / ASR_SCHOOLS in supabase/functions/_shared/day.js; an
-- unknown one reads as the default there, so no check constraint is needed.
create table if not exists public.user_settings (
  user_id    uuid        primary key default auth.uid() references auth.users on delete cascade,
  lat        double precision check (lat between -90 and 90),
  lng        double precision check (lng between -180 and 180),
  time_zone  text        not null default 'Asia/Karachi',   -- IANA, e.g. Europe/London
  method     text        not null default 'karachi',
  asr_school text        not null default 'hanafi',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

do $$ begin
  create policy "read own settings" on public.user_settings
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- The app writes with an upsert, which needs both of the next two.
do $$ begin
  create policy "insert own settings" on public.user_settings
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "update own settings" on public.user_settings
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- No delete policy: nothing deletes it, and an empty table means Karachi.

-- Stage 11: his fixed money tags, one list per direction, e.g.
--   {"out": ["Food", "Transport"], "in": ["Salary"]}
-- jsonb rather than text[] because there are two lists. Null means the app's
-- built-in defaults. Kept here, not per device, so phone and laptop agree.
alter table public.user_settings add column if not exists money_tags jsonb
  check (money_tags is null or jsonb_typeof(money_tags) = 'object');

-- ==================================================================== money
-- Stage 11. Money in and out, in PKR. Append-only, exactly as `events` is: no
-- update and no delete policy.
--
-- A CORRECTION IS A VOID ROW. It carries the mistaken row's rid in `voids_rid`
-- and copies that row's dir, amount and tag, so it passes the same checks as
-- any row and a person reading the table sees what was cancelled. The app skips
-- both rows in every figure. Chosen over `dir = 'void'`, which would need a
-- nullable amount and turn both checks below into "unless it is a void".
--
-- No foreign key from voids_rid to rid, on purpose: a void of a row still
-- waiting on the device could reach the table first, and a foreign key would
-- refuse it — for good, since a refusal is never retried.
create table if not exists public.money (
  id          uuid          primary key default gen_random_uuid(),
  user_id     uuid          not null default auth.uid() references auth.users on delete cascade,
  -- One per logical write, reused by every resend; see the unique constraint.
  rid         text          not null,
  -- The press time, not the send time, and the same readable stamp events carry.
  at          timestamptz   not null default now(),
  local_time  text          not null default '',
  tz          text          not null default '',
  dir         text          not null check (dir in ('in', 'out')),
  -- Two decimals; 0.50 is fine, 0 and negatives are refused. NaN is refused by
  -- name, because Postgres ranks NaN above every number, so NaN > 0 is true.
  amount      numeric(14,2) not null
              constraint money_amount_positive check (amount > 0 and amount <> 'NaN'),
  currency    text          not null default 'PKR',
  tag         text          not null check (char_length(tag) between 1 and 40),
  note        text          not null default '' check (char_length(note) <= 200),
  voids_rid   text          check (voids_rid is null or voids_rid <> rid),
  created_at  timestamptz   not null default now(),
  -- A resend is a no-op: the repeat fails with 23505, which the app reads as success.
  constraint money_user_rid_key unique (user_id, rid)
);

-- For a table made before the NaN rule: swap the old unnamed check for the named one.
-- Added only when missing: Money 2 (below) widens it, and putting the narrow one
-- back on a re-run would fail on a zero starting amount.
alter table public.money drop constraint if exists money_amount_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.money'::regclass
                 and conname = 'money_amount_positive') then
    alter table public.money add constraint money_amount_positive
      check (amount > 0 and amount <> 'NaN');
  end if;
end $$;

create index if not exists money_user_at_idx
  on public.money (user_id, at desc);

-- One void per row. Voiding it again, from the other device say, is a 23505:
-- already done, and read as success.
create unique index if not exists money_user_voids_idx
  on public.money (user_id, voids_rid) where voids_rid is not null;

alter table public.money enable row level security;

do $$ begin
  create policy "read own money" on public.money
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own money" on public.money
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- So the other device's Money screen updates without a refresh.
do $$ begin
  alter publication supabase_realtime add table public.money;
exception when duplicate_object then null; end $$;

-- ================================================================== google
-- Stage 12. The Google grant (Tasks, and Drive files ProBeing makes), held by
-- the google-link Edge Function. The sign-in stays GitHub; this is a separate
-- permission keyed to the same user.

-- google_grants: the encrypted tokens. RLS on and NO policies, and every
-- privilege taken from the browser roles: only the service role reads it.
-- refresh_enc / access_enc are AES-GCM under the GOOGLE_TOKEN_KEY function
-- secret, so a leaked backup of this table is noise.
create table if not exists public.google_grants (
  -- Written by the function with the service role, so user_id is always named.
  user_id           uuid        primary key references auth.users on delete cascade,
  google_email      text        not null default '',
  scopes            text[]      not null default '{}',   -- only what Google granted
  refresh_enc       text        not null,
  access_enc        text,
  access_expires_at timestamptz,
  list_id           text,                                 -- the one Tasks list mirrored
  list_title        text,
  sheet_id          text,                                 -- Stage 18's export sheet
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.google_grants enable row level security;
revoke all on table public.google_grants from anon, authenticated;

-- oauth_states: the sha256 of each Connect's state nonce, for 10 minutes.
-- Finishing marks it used in the same statement that checks it.
create table if not exists public.oauth_states (
  nonce_sha256 text        primary key,
  user_id      uuid        not null references auth.users on delete cascade,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists oauth_states_user_idx
  on public.oauth_states (user_id, expires_at);

alter table public.oauth_states enable row level security;
revoke all on table public.oauth_states from anon, authenticated;

-- sync_state: what Settings shows about the connection. No tokens here. The
-- browser may read its own row; only the function writes. Later stages fill
-- the pull, push and export columns.
create table if not exists public.sync_state (
  user_id         uuid        primary key references auth.users on delete cascade,
  connected       boolean     not null default false,
  google_email    text,
  list_title      text,
  last_pull_ok_at timestamptz,
  last_push_ok_at timestamptz,
  -- Starts 'Reconnect Google' when only a new Connect can fix it.
  last_error      text,
  last_error_at   timestamptz,
  deep_ignored    integer     not null default 0,        -- sub-tasks too deep to mirror
  sheet_url       text,
  last_export_at  timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.sync_state enable row level security;

do $$ begin
  create policy "read own sync state" on public.sync_state
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.sync_state from anon, authenticated;

-- So both devices' Settings hear a connect, a list change or an error.
do $$ begin
  alter publication supabase_realtime add table public.sync_state;
exception when duplicate_object then null; end $$;

-- Stage 13: the list tasks-sync last read, so the browser shows only its rows.
alter table public.sync_state add column if not exists list_id text;

-- task_nodes: Stage 13's copy of his chosen Tasks list, written only by the
-- tasks-sync function. Top-level tasks are projects, their children sub-tasks;
-- deeper ones are not kept. Google wins for the tree; nothing is deleted here —
-- a task gone from Google gets gone_at, so time and items (Stage 14) stay
-- attached to its stable id. Rows of a list no longer chosen stay, unmarked.
create table if not exists public.task_nodes (
  id               uuid        primary key default gen_random_uuid(),
  -- Written with the service role, so user_id is always named.
  user_id          uuid        not null references auth.users on delete cascade,
  google_id        text        not null,
  list_id          text        not null,                  -- the Tasks list it came from
  parent_google_id text,                                  -- null for a project
  kind             text        not null check (kind in ('project', 'subtask')),
  title            text        not null default '',
  position         text        not null default '',       -- Google's sort key
  due              date,                                  -- date only, as Google keeps it
  g_status         text        not null default 'needsAction',
  g_completed_at   timestamptz,
  g_updated        timestamptz,
  g_reopened_at    timestamptz,                           -- unticked in Google
  pb_done_at       timestamptz,                           -- Stage 15
  pb_pushed_at     timestamptz,                           -- Stage 15
  missing_since    timestamptz,                           -- absent from one complete pull
  gone_at          timestamptz,                           -- deleted, or absent from two in a row
  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  -- What the function upserts on: two syncs at once cannot make a second row.
  constraint task_nodes_user_google_key unique (user_id, google_id)
);

-- For a table made before list_id and missing_since. A row with no list to
-- give it is dropped: it is a copy, and the next sync makes it again.
alter table public.task_nodes add column if not exists missing_since timestamptz;
alter table public.task_nodes add column if not exists list_id text;
update public.task_nodes n set list_id = g.list_id
  from public.google_grants g where g.user_id = n.user_id and n.list_id is null;
delete from public.task_nodes where list_id is null;
alter table public.task_nodes alter column list_id set not null;

create index if not exists task_nodes_user_parent_idx
  on public.task_nodes (user_id, parent_google_id);

alter table public.task_nodes enable row level security;

do $$ begin
  create policy "read own task nodes" on public.task_nodes
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.task_nodes from anon, authenticated;

-- So a sync on one device (or the scheduler) redraws both.
do $$ begin
  alter publication supabase_realtime add table public.task_nodes;
exception when duplicate_object then null; end $$;

-- ================================================================== loans
-- Stage 13b. A loan is a money row with kind 'loan' and the person it was with.
-- dir says which way the cash went: I lent / I paid back are 'out', I borrowed /
-- they paid me back are 'in'. tag stays required and carries a fixed word
-- ("Lent", "Borrowed", "Repaid to me", "Repaid by me"), so an app from before
-- this reads the row as plain cash with a sensible name. Existing rows are cash.
alter table public.money add column if not exists kind text not null default 'cash';
alter table public.money add column if not exists person text;

-- Added only when missing, like money_amount_positive: Money 2 widens it below.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.money'::regclass
                 and conname = 'money_kind_check') then
    alter table public.money add constraint money_kind_check check (kind in ('cash', 'loan'));
  end if;
end $$;
alter table public.money drop constraint if exists money_person_check;
alter table public.money add constraint money_person_check
  check (person is null or char_length(person) between 1 and 40);
-- A balance is per person, so a loan without one could never be settled.
alter table public.money drop constraint if exists money_loan_person;
alter table public.money add constraint money_loan_person
  check (kind <> 'loan' or person is not null);

-- ======================================================== prayer reminders
-- 29 Sep. The prayer-remind Edge Function pushes when a prayer's time begins
-- and 60/30/15 minutes before it ends while it is not logged. Its schedule is
-- supabase/sql/prayer_remind.sql.

-- The Settings toggle. Owner-writable through the user_settings policies above.
alter table public.user_settings add column if not exists prayer_reminders boolean not null default true;

-- One row per reminder sent, so none is sent twice. Server-only: RLS on, no
-- policies, nothing granted to the browser roles.
--   kind  'Asr-begin', 'Asr-60', 'Asr-30', 'Asr-15', or 'Asr-clear' (the quiet
--         push that replaces a reminder once the prayer is logged)
--   day   the date whose prayer times it belongs to (Isha's run past midnight)
create table if not exists public.reminders_sent (
  -- Written with the service role, so user_id is always named.
  user_id  uuid        not null references auth.users on delete cascade,
  kind     text        not null,
  day      date        not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, kind, day)
);

alter table public.reminders_sent enable row level security;
revoke all on table public.reminders_sent from anon, authenticated;

-- ============================================================ tasks page
-- The Tasks page (29 Sep). "Start working on it" names its task on the work
-- row it writes, so later stages can count time per sub-task. Stage 14a lets a
-- blank one be filled once, later in this file. Tasks are never deleted, so the
-- reference holds.
alter table public.events add column if not exists node_id uuid
  references public.task_nodes(id) on delete set null;

-- A foreign key ignores row level security, so without this a row could name
-- another user's task. Altered in place: the policy is never absent, not even
-- for an instant, so a press arriving mid-change is not refused.
alter policy "insert own rows" on public.events
  with check (auth.uid() = user_id and (node_id is null or exists (
    select 1 from public.task_nodes n where n.id = node_id and n.user_id = auth.uid())));

-- His plan for a task: on the Planned list or not, and when he expects to
-- finish it. ProBeing's own; Google keeps no times. One row per task, written
-- by the app with an upsert, so both devices see one answer. No delete: taking
-- a task off Planned sets planned = false.
create table if not exists public.task_plans (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  node_id     uuid        not null references public.task_nodes(id) on delete cascade,
  planned     boolean     not null default false,
  expected_at timestamptz,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint task_plans_user_node_key unique (user_id, node_id)
);

alter table public.task_plans enable row level security;

do $$ begin
  create policy "read own task plans" on public.task_plans
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Only for his own tasks: a plan row cannot point at someone else's node.
do $$ begin
  create policy "insert own task plans" on public.task_plans
    for insert with check (auth.uid() = user_id and exists (
      select 1 from public.task_nodes n where n.id = node_id and n.user_id = auth.uid()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "update own task plans" on public.task_plans
    for update using (auth.uid() = user_id)
    with check (auth.uid() = user_id and exists (
      select 1 from public.task_nodes n where n.id = node_id and n.user_id = auth.uid()));
exception when duplicate_object then null; end $$;

revoke delete, truncate on table public.task_plans from anon, authenticated;

-- So a plan changed on one device redraws the other.
do $$ begin
  alter publication supabase_realtime add table public.task_plans;
exception when duplicate_object then null; end $$;

-- ============================================================ filing (14a)
-- Stage 14a. The classify Edge Function files each typed entry under one of his
-- Google tasks; supabase/sql/classify.sql schedules it. The three tables below are
-- written by the server only. The browser reads entry_filing and items, and
-- files an Unsorted entry itself through the label policy.

-- The label policy, widened: a blank entry (project '' AND no node_id) may be
-- filled once with project, detail and node_id, and only with a node of his
-- own. Once either is set the row is frozen. Altered in place, as above.
alter policy "label own unlabelled rows" on public.events
  using (auth.uid() = user_id and project = '' and node_id is null and type in ('work', 'voice'))
  with check (auth.uid() = user_id and (node_id is null or exists (
    select 1 from public.task_nodes n where n.id = node_id and n.user_id = auth.uid())));
grant update (project, detail, node_id) on public.events to authenticated;

-- entry_filing: one row per entry the server is to file, keyed by the entry's
-- rid. pending -> filed or unsorted. claimed_until/claim_id let only one run
-- work on a row at a time; tries counts Gemini answers that could not be used.
create table if not exists public.entry_filing (
  -- Written with the service role, so user_id is always named.
  user_id       uuid        not null references auth.users on delete cascade,
  entry_rid     text        not null,
  state         text        not null default 'pending'
                            check (state in ('pending', 'filed', 'unsorted')),
  reason        text        not null default '',
  tries         integer     not null default 0,
  claimed_until timestamptz,
  claim_id      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, entry_rid)
);

create index if not exists entry_filing_user_state_idx
  on public.entry_filing (user_id, state, created_at);

alter table public.entry_filing enable row level security;

do $$ begin
  create policy "read own filing" on public.entry_filing
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.entry_filing from anon, authenticated;

-- So "filing…" turns into a name, or into the Unsorted tray, on both devices.
do $$ begin
  alter publication supabase_realtime add table public.entry_filing;
exception when duplicate_object then null; end $$;

-- items: the small jobs Gemini reads out of an entry. rid is <entry rid>-i<k>,
-- so filing the same entry twice makes one set. node_id is null while the
-- entry is Unsorted. Server-written in 14a; the Done/Drop marks come in 14b.
create table if not exists public.items (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  rid         text        not null,
  node_id     uuid        references public.task_nodes(id) on delete set null,
  source_rid  text,                                     -- the entry it came from
  title       text        not null check (char_length(title) between 1 and 200),
  made_by     text        not null default 'gemini' check (made_by in ('gemini', 'hand')),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint items_user_rid_key unique (user_id, rid)
);

create index if not exists items_user_node_idx on public.items (user_id, node_id);
create index if not exists items_user_source_idx on public.items (user_id, source_rid);

alter table public.items enable row level security;

do $$ begin
  create policy "read own items" on public.items
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.items from anon, authenticated;

do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;

-- gemini_usage: Gemini calls per Google quota day (the Pacific date, when the
-- free tier's daily count resets), one tally for every device and the server. No browser access at all: nothing on screen reads it yet, and
-- the table editor shows it.
create table if not exists public.gemini_usage (
  user_id  uuid        not null references auth.users on delete cascade,
  day      date        not null,
  n        integer     not null default 0 check (n >= 0),
  last_at  timestamptz,
  primary key (user_id, day)
);

alter table public.gemini_usage enable row level security;
revoke all on table public.gemini_usage from anon, authenticated;

-- Take one call from the day's budget, in one statement so two runs cannot
-- both take the last one. Returns the new count; 0 when the day is spent
-- (p_cap reached); -1 when the last call was under p_pace_ms ago. A null
-- p_cap counts without limiting (the gemini function's own calls).
create or replace function public.gemini_usage_take(p_user uuid, p_day date,
                                                    p_cap integer, p_pace_ms integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  got integer;
begin
  insert into public.gemini_usage (user_id, day) values (p_user, p_day)
    on conflict (user_id, day) do nothing;
  update public.gemini_usage
     set n = n + 1, last_at = now()
   where user_id = p_user and day = p_day
     and (p_cap is null or n < p_cap)
     and (coalesce(p_pace_ms, 0) <= 0 or last_at is null
          or last_at <= now() - p_pace_ms * interval '1 millisecond')
  returning n into got;
  if got is not null then return got; end if;
  select case when p_cap is not null and n >= p_cap then 0 else -1 end into got
    from public.gemini_usage where user_id = p_user and day = p_day;
  return got;
end;
$fn$;

-- Google said the day is gone: count it spent, whatever this tally thought.
create or replace function public.gemini_usage_spend(p_user uuid, p_day date, p_cap integer)
returns void
language sql
security definer
set search_path = ''
as $fn$
  insert into public.gemini_usage (user_id, day, n, last_at) values (p_user, p_day, p_cap, now())
    on conflict (user_id, day) do update
      set n = greatest(public.gemini_usage.n, excluded.n), last_at = now();
$fn$;

-- Callable over the REST API only by the service role.
revoke all on function public.gemini_usage_take(uuid, date, integer, integer) from public, anon, authenticated;
revoke all on function public.gemini_usage_spend(uuid, date, integer) from public, anon, authenticated;
grant execute on function public.gemini_usage_take(uuid, date, integer, integer) to service_role;
grant execute on function public.gemini_usage_spend(uuid, date, integer) to service_role;

-- Filed from the Unsorted tray: the browser sets the entry's node_id, and this
-- moves its filing row to filed and its items under the same node. Only an
-- Unsorted row: the server's own filing sets its state itself. A failure here
-- never refuses the filing; the tray hides a filed entry either way.
create or replace function public.entry_filed_by_hand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  begin
    update public.entry_filing
       set state = 'filed', reason = 'by hand', updated_at = now(),
           claimed_until = null, claim_id = null
     where user_id = new.user_id and entry_rid = new.rid and state = 'unsorted';
    if found then
      update public.items set node_id = new.node_id
       where user_id = new.user_id and source_rid = new.rid and node_id is null;
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$fn$;

revoke all on function public.entry_filed_by_hand() from public, anon, authenticated;

drop trigger if exists entry_filed_by_hand on public.events;
create trigger entry_filed_by_hand
  after update of node_id on public.events
  for each row
  when (old.node_id is null and new.node_id is not null and new.rid is not null)
  execute function public.entry_filed_by_hand();

-- ====================================================== items (14b)
-- Stage 14b. Done and Drop on an item, and items added by hand.

-- A hand-added item: his own, under a task of his own, never pretending to be
-- Gemini's or to come from an entry. classify keeps writing with the service
-- role. Column grant: the browser cannot set id, created_at or user_id.
do $$ begin
  create policy "insert own hand items" on public.items
    for insert with check (auth.uid() = user_id and made_by = 'hand' and source_rid is null and
      node_id is not null and exists (
        select 1 from public.task_nodes n where n.id = node_id and n.user_id = auth.uid()));
exception when duplicate_object then null; end $$;
grant insert (rid, node_id, title, made_by, at) on public.items to authenticated;

-- item_marks: every Done, Drop and Undo ('open'), append-only. An item's state
-- is its newest mark by `at`, ties by created_at; no mark is open.
-- item_rid, not the item's id: an item added offline has no id until it lands,
-- and a mark made on it meanwhile must still name it. A rid is only unique per
-- user, so a mark can only ever name the marker's own items. No check that the
-- item exists: a mark may reach the table before its item does, and a refusal
-- is never retried (money's voids_rid, for the same reason).
create table if not exists public.item_marks (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  rid         text        not null,
  item_rid    text        not null check (char_length(item_rid) between 1 and 200),
  mark        text        not null check (mark in ('done', 'drop', 'open')),
  at          timestamptz not null default now(),
  local_time  text        not null default '',
  created_at  timestamptz not null default now(),
  constraint item_marks_user_rid_key unique (user_id, rid)
);

create index if not exists item_marks_user_item_idx on public.item_marks (user_id, item_rid, at desc);

alter table public.item_marks enable row level security;

do $$ begin
  create policy "read own marks" on public.item_marks
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own marks" on public.item_marks
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- No update or delete: Undo is another mark.
revoke insert, update, delete, truncate on table public.item_marks from anon, authenticated;
grant insert (rid, item_rid, mark, at, local_time) on public.item_marks to authenticated;

-- So a Done on one device redraws the other.
do $$ begin
  alter publication supabase_realtime add table public.item_marks;
exception when duplicate_object then null; end $$;

-- The newest mark of each item, the state the app draws: one row per item
-- instead of every mark ever made. Same order as day.js itemStates. It reads
-- item_marks as the caller (security_invoker, Postgres 15+), so the policies
-- above still decide: his own marks only.
create or replace view public.item_mark_latest with (security_invoker = true) as
  select distinct on (user_id, item_rid) rid, user_id, item_rid, mark, at, local_time, created_at
    from public.item_marks
   order by user_id, item_rid, at desc, created_at desc, rid desc;
revoke all on public.item_mark_latest from anon, authenticated;
grant select on public.item_mark_latest to authenticated;

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
-- schedule below runs every ten minutes across UTC 18:00–06:59, which is
-- 11:00 PM to 11:59 AM in Karachi: early enough to catch the 11:30 check, and
-- late enough that the last check (10:00, answered checks repeat every 90
-- minutes until 11 AM) still gets its answer an hour later.
-- Check what the database believes with:  select now();
--
-- Every ten minutes rather than once at 18:30, because the function decides for
-- itself what the time means (see shouldWrapUp) and a single fire has no second
-- chance if it lands while the push service is unreachable.
--
-- STAGE 10: ALL DAY, '*/10 * * * *'. The function now reads the night's times
-- on the clock of the zone in user_settings, so in any zone but Karachi's the
-- UTC 18:00-06:59 window above misses part of the night (UTC+8's 23:30 is 15:30
-- UTC). Outside the night every run decides 'nothing'. Karachi alone needs only
-- the old window, which is still what is live until this is re-run.
--
--   select cron.schedule('probeing-wrapup', '*/10 * * * *', $job$
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

-- ================================================================ money 2
-- 1 Oct. Dues and a running wallet, still in the one append-only money table.
--   kind 'loan'     cash moved between him and a person: the 13b rows, "cash
--                   moved now", and settlements. dir is the way the cash went.
--   kind 'due'      a record only, no cash moved: dir 'they_owe' or 'i_owe'.
--   kind 'opening'  what the wallet held at `at`; dir 'set'; 0 is allowed.
-- The new dirs are outside in/out on purpose: the app before Money 2 counts an
-- in/out row that is not a loan as spending or income, and skips any other dir.
-- Every live row (cash and loan, in or out) passes all five checks below.
-- To see what is there first:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.money'::regclass and contype = 'c';
-- Item 19 widens these two again below. Once it has, a re-run leaves them alone:
-- putting this narrower pair back would fail on a buying-list row.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.money'::regclass
                 and conname = 'money_kind_check' and pg_get_constraintdef(oid) like '%buy%') then
    alter table public.money drop constraint if exists money_kind_check;
    alter table public.money add constraint money_kind_check
      check (kind in ('cash', 'loan', 'due', 'opening'));
    -- money_dir_check is the name Postgres gave the column check in create table.
    alter table public.money drop constraint if exists money_dir_check;
    alter table public.money add constraint money_dir_check check (
      (kind in ('cash', 'loan') and dir in ('in', 'out')) or
      (kind = 'due' and dir in ('they_owe', 'i_owe')) or
      (kind = 'opening' and dir = 'set'));
  end if;
end $$;
alter table public.money drop constraint if exists money_amount_positive;
alter table public.money add constraint money_amount_positive
  check (amount <> 'NaN' and (amount > 0 or (kind = 'opening' and amount = 0)));
-- A due, like a loan, is per person.
alter table public.money drop constraint if exists money_loan_person;
alter table public.money add constraint money_loan_person
  check (kind not in ('loan', 'due') or person is not null);
-- A wallet count belongs to nobody.
alter table public.money drop constraint if exists money_opening_person;
alter table public.money add constraint money_opening_person
  check (kind <> 'opening' or person is null);

-- ============================================================ write-back (15)
-- Stage 15. tasks-sync sends what finished in ProBeing back to Google Tasks.
-- task_nodes stays server-written; these record what was sent, so a change is
-- sent once and a change made in Google afterwards is not sent over.
--   pb_due / pb_due_sent_at  the due date last sent from his finish date (null
--                            date + a time = it was cleared); null time = never sent
--   pb_due_for               the finish that date came from, so a zone change alone
--                            sends nothing
--   push_refused             {body, n, why}: a change Google refused (a 4xx); after
--                            3 runs the same change is not sent again
--   push_claim_until         one run at a time sends for a task; a dead run's lapses
--   pb_completed_at          Google's `completed` time for ProBeing's tick; while it
--                            is unchanged the tick is ProBeing's, so an Undo may untick
alter table public.task_nodes add column if not exists pb_due date;
alter table public.task_nodes add column if not exists pb_due_sent_at timestamptz;
alter table public.task_nodes add column if not exists pb_due_for timestamptz;
alter table public.task_nodes add column if not exists push_refused jsonb;
alter table public.task_nodes add column if not exists push_claim_until timestamptz;
alter table public.task_nodes add column if not exists pb_completed_at timestamptz;

-- tasks_sync_wants: the throttle for supabase/sql/tasks_sync.sql's triggers. wanted_n
-- counts changes; sent_at is set while a request is out, so a burst of taps is
-- one sync. tasks-sync clears it when no change came in during its run.
-- Server-only: RLS on, no policies, nothing granted to the browser roles.
create table if not exists public.tasks_sync_wants (
  -- Written by a trigger and the service role, so user_id is always named.
  user_id    uuid        primary key references auth.users on delete cascade,
  wanted_n   bigint      not null default 0,
  wanted_at  timestamptz,
  sent_at    timestamptz
);

alter table public.tasks_sync_wants enable row level security;
revoke all on table public.tasks_sync_wants from anon, authenticated;

-- ======================================================== feedback 1 (6 Oct)
-- Deadline reminders: prayer-remind also pushes "30 min left" for a task whose
-- expected finish is near. Its own toggle, separate from prayer_reminders.
-- Dedupe in reminders_sent, kind 'task-30-<node id>-<expected_at ms>'.
alter table public.user_settings add column if not exists task_reminders boolean not null default true;

-- When the expected finish itself was last set. updated_at moves on a Planned
-- toggle too, which made a toggle look like a late finish and cancelled the
-- "30 min left" push. A trigger keeps it on the server clock, so no device can
-- forge it. Backfilled from updated_at (the best there is) before the trigger exists.
alter table public.task_plans add column if not exists expected_set_at timestamptz;
drop trigger if exists task_plans_expected_set on public.task_plans;
update public.task_plans set expected_set_at = updated_at
 where expected_set_at is null and expected_at is not null;

create or replace function public.task_plans_expected_set()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' or new.expected_at is distinct from old.expected_at then
    new.expected_set_at := case when new.expected_at is null then null else now() end;
  else
    new.expected_set_at := old.expected_set_at;
  end if;
  return new;
end;
$fn$;

revoke all on function public.task_plans_expected_set() from public, anon, authenticated;

create trigger task_plans_expected_set
  before insert or update on public.task_plans
  for each row
  execute function public.task_plans_expected_set();

-- ============================================================ sheets copy (18)
-- The sheets-export function's own messages, kept apart from last_error, which
-- every clean tasks-sync pull clears. export_error: the last export's failure,
-- null after a good one. sheet_note: set when a new sheet replaced one that was
-- in the bin or deleted. Browser-readable through "read own sync state".
alter table public.sync_state add column if not exists export_error text;
alter table public.sync_state add column if not exists sheet_note text;
-- Held by a running export, so two at once cannot each make a sheet. Server-only, like the table.
alter table public.google_grants add column if not exists export_claim_until timestamptz;

-- ======================================================== stage 17 (7 Oct)
-- The morning push: prayer-remind sends "Today: N due, M carried over, P planned" once per
-- counter day at plan_push_time, read on the clock of time_zone above. Its own
-- toggle. Dedupe in reminders_sent, kind 'plan', day = the counter date.
alter table public.user_settings add column if not exists plan_push boolean not null default true;
alter table public.user_settings add column if not exists plan_push_time time not null default '09:00';

-- ===================================================== edit queue 2 (7 Oct)
-- classify's plan for a new sub-task (Gemini knew the project, not the task):
-- the title and the project's google_id, saved BEFORE tasks.insert, then the
-- new task's id once Google answers. A run that finds a plan without an id
-- looks in Google before inserting again, so an entry makes at most one.
-- Server-written like the rest of entry_filing; cleared when it ends Unsorted.
alter table public.entry_filing add column if not exists new_title text;
alter table public.entry_filing add column if not exists new_parent text;
alter table public.entry_filing add column if not exists new_google_id text;
alter table public.entry_filing add column if not exists new_at timestamptz;

-- ===================================================== edit queue 4 (8 Oct)
-- classify's plan for the OTHER new sub-tasks one entry makes (up to 5 in all):
-- [{j, title, items, google_id, at}], saved before the first insert, like the
-- new_* columns above. Without it, classify makes only the main one.
alter table public.entry_filing add column if not exists new_more jsonb;
-- A Stop on a task is an events row of type 'substop' (node_id = the task): no
-- schema change, as events.type is free text.

-- ======================================================== item 19 (8 Oct)
-- The buying list on the Money screen, in the same append-only money table.
--   kind 'buy'   a thing he means to buy: dir 'plan', its name in tag, the
--                expected amount, and the month in buy_month ('2026-10').
-- It is off the list once a void row names it (voids_rid), as every money
-- correction is: note 'Bought' or 'Removed'. Bought also writes an ordinary
-- cash expense, rid 'bb-' + the thing's rid. A 'buy' row never counts in
-- spent, got or the wallet; the app before this skips it (its dir is not in/out).
-- Item 20 (no schema change): Move is a void with note 'Moved' (rid 'bm-' + the
-- thing's rid) plus the same thing in its new month (rid 'mv-' + the thing's rid).
-- Run this section on its own; the whole file re-run afterwards is safe too.
alter table public.money add column if not exists buy_month text;
alter table public.money drop constraint if exists money_kind_check;
alter table public.money add constraint money_kind_check
  check (kind in ('cash', 'loan', 'due', 'opening', 'buy'));
alter table public.money drop constraint if exists money_dir_check;
alter table public.money add constraint money_dir_check check (
  (kind in ('cash', 'loan') and dir in ('in', 'out')) or
  (kind = 'due' and dir in ('they_owe', 'i_owe')) or
  (kind = 'opening' and dir = 'set') or
  (kind = 'buy' and dir = 'plan'));
-- A month on every thing, and on nothing else.
alter table public.money drop constraint if exists money_buy_month;
alter table public.money add constraint money_buy_month check (
  (kind = 'buy') = (buy_month is not null) and
  (buy_month is null or buy_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));
-- A thing belongs to nobody.
alter table public.money drop constraint if exists money_buy_person;
alter table public.money add constraint money_buy_person
  check (kind <> 'buy' or person is null);

-- ============================================================ stage 18a (8 Oct)
-- Several tasks at once, a pin, priority and effort, a Backlog, and Drop
-- deleting the task in Google. Safe to run twice.
-- New events types need no schema change (events.type is free text):
--   pin / unpin  node_id = the task; while pinned it alone collects time
--   taskmeta     node_id = the task; detail 'p=high;e=m' (priority and effort) or 'skip'
--   subnew       node_id = a project; raw_text = a sub-task added by hand, made in
--                Google by tasks-sync (supabase/sql/tasks_sync.sql pokes it)
-- A Drop whose text ends ' (deleted in Google)' deletes the task there (tree.js).

-- The counter day a task was planned for. Planned from an earlier day and not
-- finished = Backlog. Null on plans made before this: their updated_at's day is used.
alter table public.task_plans add column if not exists planned_for date;

-- tasks-sync's record of a Drop it deleted in Google (the Drop's rid, and when)
-- and of a Reopen it made again (the Reopen's rid). Server-written, like the rest.
alter table public.task_nodes add column if not exists pb_deleted_for text;
alter table public.task_nodes add column if not exists pb_deleted_at timestamptz;
alter table public.task_nodes add column if not exists pb_recreated_for text;

-- subtask_requests: one row per sub-task added by hand (its subnew rid), written
-- before Google is asked, so a run that dies never makes it twice. The server
-- writes it; the browser may only read its own rows (below).
create table if not exists public.subtask_requests (
  -- Written with the service role, so user_id is always named.
  user_id    uuid        not null references auth.users on delete cascade,
  rid        text        not null,
  state      text        not null default 'sending' check (state in ('sending', 'made', 'failed')),
  google_id  text,
  tried_at   timestamptz,
  tries      integer     not null default 0,
  why        text,
  created_at timestamptz not null default now(),
  primary key (user_id, rid)
);

alter table public.subtask_requests enable row level security;
revoke all on table public.subtask_requests from anon, authenticated;
-- Fix round: the browser reads its own rows (select only), to say when Google
-- refused a sub-task and offer Retry or Remove. Writes stay with the server.
drop policy if exists "read own subtask requests" on public.subtask_requests;
create policy "read own subtask requests" on public.subtask_requests
  for select to authenticated using (auth.uid() = user_id);
grant select on table public.subtask_requests to authenticated;

-- ============================================================ stage 18b (9 Oct)
-- The laptop activity watcher. watcher/windows/watch.ps1 reads ActivityWatch on
-- the laptop and sends TIME BLOCKS to the activity-ingest Edge Function: start,
-- end, app, site (host only), project, category, and the keyword that matched.
-- Never a URL, never page text, never a window title (Saad, 9 Oct). The checks
-- below refuse a URL or a file path even if a bug tried to store one.
-- New events types need no schema change (events.type is free text):
--   actfix     a corrected block: detail = block ids (comma separated), project = the new one
--   actseen    the catch-up popup confirmed, detail = up to when (ISO)
--   actanswer  "I'm working" to a distraction push (rid an-<nudge>) or a question (aq-<nudge>)
-- and break/resume rows with fixed rids: ab-/ar- (the watcher's own break and its
-- resume), qb-/qr- (a question answered "break"), kb-/kr- (a span marked break),
-- aw- (an auto break undone). Safe to run twice.

-- Distraction, private and meeting lists ({"distract": [...], "private": [...],
-- "meeting": [...]}; a missing list is the built-in one) and the push/auto-break switch.
alter table public.user_settings add column if not exists activity_lists jsonb
  check (activity_lists is null or jsonb_typeof(activity_lists) = 'object');
alter table public.user_settings add column if not exists activity_nudge boolean not null default true;

-- watch_devices: one row per paired laptop (a phone later, 18c). Like
-- device_keys: Settings makes a token, shows it once, and stores only its
-- sha256 (of the token with dashes and case taken off). The browser can never
-- read the fingerprint back.
create table if not exists public.watch_devices (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users on delete cascade,
  secret_sha256 text        not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  label         text        not null default '' check (char_length(label) <= 80),
  kind          text        not null default 'laptop' check (kind in ('laptop', 'phone')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create unique index if not exists watch_devices_secret_idx on public.watch_devices (secret_sha256);
create index if not exists watch_devices_user_idx on public.watch_devices (user_id);

alter table public.watch_devices enable row level security;

do $$ begin
  create policy "read own watchers" on public.watch_devices
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own watchers" on public.watch_devices
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Revoke = delete the row; its blocks stay for the reports.
do $$ begin
  create policy "delete own watchers" on public.watch_devices
    for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.watch_devices from anon, authenticated;
grant select (id, user_id, label, kind, created_at, last_seen_at) on public.watch_devices to authenticated;
grant insert (user_id, secret_sha256, label, kind) on public.watch_devices to authenticated;
grant delete on public.watch_devices to authenticated;

-- activity_blocks: the time blocks. Written by activity-ingest only (service
-- role); one per device and start, so a re-sent block updates in place.
create table if not exists public.activity_blocks (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users on delete cascade,
  device_id   uuid        references public.watch_devices(id) on delete set null,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  app         text        not null default '' check (char_length(app) <= 80 and app !~ '[/\\]'),
  domain      text        not null default '' check (domain = '' or domain ~ '^[a-z0-9.-]{1,253}$'),
  category    text        not null check (category in ('work', 'meeting', 'distraction', 'unclear', 'private')),
  project     text        not null default '' check (char_length(project) <= 120),
  rule_key    text        not null default '' check (rule_key ~ '^[0-9a-z\u0080-￿]{0,40}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint activity_blocks_device_start_key unique (device_id, started_at),
  constraint activity_blocks_span check (ended_at > started_at and ended_at <= started_at + interval '12 hours'),
  constraint activity_blocks_private check (category <> 'private' or (domain = '' and project = '' and rule_key = ''))
);

create index if not exists activity_blocks_user_end_idx on public.activity_blocks (user_id, ended_at desc);

alter table public.activity_blocks enable row level security;

do $$ begin
  create policy "read own blocks" on public.activity_blocks
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.activity_blocks from anon, authenticated;

-- activity_rules: keyword -> project. His own ('hand'), or from a correction in the
-- catch-up sheet ('fix', the block's site or app name). Never words from a window
-- title, and never from Gemini (Saad, 9 Oct). The keyword is squashed: lower case,
-- letters and digits ("probeing").
create table if not exists public.activity_rules (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  keyword     text        not null check (keyword ~ '^[0-9a-z\u0080-￿]{4,40}$'),
  project     text        not null check (char_length(project) between 1 and 120),
  source      text        not null default 'hand' check (source in ('hand', 'fix')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint activity_rules_user_keyword_key unique (user_id, keyword)
);

alter table public.activity_rules enable row level security;

do $$ begin
  create policy "read own rules" on public.activity_rules
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own rules" on public.activity_rules
    for insert with check (auth.uid() = user_id and source in ('hand', 'fix'));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "update own rules" on public.activity_rules
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id and source in ('hand', 'fix'));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "delete own rules" on public.activity_rules
    for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.activity_rules from anon, authenticated;
grant select, delete on public.activity_rules to authenticated;
grant insert (user_id, keyword, project, source) on public.activity_rules to authenticated;
grant update (project, source, updated_at) on public.activity_rules to authenticated;

-- activity_nudges: one row per distraction streak pushed (device + start), so
-- none is pushed twice. state: sent -> working / break / answered / left /
-- autobreak / question / stale / closed. nonce_sha256 lets the push's buttons
-- answer without a sign-in (as wrapup's check does); the browser cannot read it.
-- A 'question' (another device showed work in the same span) waits for the
-- catch-up popup: span_end and other_work say what to ask.
create table if not exists public.activity_nudges (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users on delete cascade,
  device_id     uuid        references public.watch_devices(id) on delete set null,
  streak_start  timestamptz not null,
  what          text        not null default '' check (char_length(what) <= 80),
  pushed_at     timestamptz,
  nonce_sha256  text,
  state         text        not null default 'sent' check (state in ('sent', 'working', 'break', 'answered',
                            'left', 'autobreak', 'question', 'stale', 'closed')),
  span_end      timestamptz,
  other_work    text        not null default '' check (char_length(other_work) <= 160),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint activity_nudges_streak_key unique (user_id, device_id, streak_start)
);

create index if not exists activity_nudges_user_state_idx on public.activity_nudges (user_id, state, created_at desc);

alter table public.activity_nudges enable row level security;

do $$ begin
  create policy "read own nudges" on public.activity_nudges
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.activity_nudges from anon, authenticated;
grant select (id, user_id, device_id, streak_start, what, pushed_at, state, span_end, other_work, decided_at, created_at)
  on public.activity_nudges to authenticated;

-- ============================================================ item 23 (11 Oct)
-- Watching extends to sleep and breaks, but only bare: a block kept while asleep
-- or on a break is its time, category and (work or meeting) project; no app,
-- site or keyword (mode 'sleep' / 'break'). New events rid prefixes, no schema
-- change: nw- (a wake back to first use, "I'm awake"), nr- (a resume back to the
-- work, "Resume"), na- (an actanswer: "Still asleep" / "It was a break").
-- Safe to run twice.

alter table public.activity_blocks add column if not exists mode text not null default 'work';

do $$ begin
  alter table public.activity_blocks add constraint activity_blocks_mode check (mode in ('work', 'break', 'sleep'));
exception when duplicate_object then null; end $$;

-- A bare block names nothing: the table refuses it even if a bug tried.
do $$ begin
  alter table public.activity_blocks add constraint activity_blocks_bare
    check (mode = 'work' or (app = '' and domain = '' and rule_key = ''));
exception when duplicate_object then null; end $$;

-- activity_nudges carries the two new questions: kind 'awake' and 'resume', with
-- ref_at = the sleep or break row they are about.
alter table public.activity_nudges add column if not exists kind text not null default 'distract';
alter table public.activity_nudges add column if not exists ref_at timestamptz;

do $$ begin
  alter table public.activity_nudges add constraint activity_nudges_kind check (kind in ('distract', 'awake', 'resume'));
exception when duplicate_object then null; end $$;

-- Re-added on every run, so it carries item 28's and 29's states too (a narrower list would refuse their rows).
alter table public.activity_nudges drop constraint if exists activity_nudges_state_check;
alter table public.activity_nudges add constraint activity_nudges_state_check check (state in ('sent', 'working', 'break',
  'answered', 'left', 'autobreak', 'question', 'stale', 'closed', 'awake', 'asleep', 'resumed', 'started', 'notwork',
  'asking', 'rejected', 'pending', 'applied'));   -- rejected: item 30b; pending, applied: item 31ab

-- One per device, kind and start: an awake run and a distraction streak never collide.
alter table public.activity_nudges drop constraint if exists activity_nudges_streak_key;
do $$ begin
  alter table public.activity_nudges add constraint activity_nudges_kind_streak_key
    unique (user_id, device_id, kind, streak_start);
exception when duplicate_object or duplicate_table then null; end $$;

grant select (kind, ref_at) on public.activity_nudges to authenticated;

-- activity_nights: a disturbed night. Asleep (a night sleep: from 9 pm or after
-- midnight) and a device in use before Fajr, 5 minutes or more at a time. One
-- row per sleep, recounted by activity-ingest; a night that turns out undisturbed
-- (a wake moved earlier) is deleted. Read by Review and the reports.
create table if not exists public.activity_nights (
  user_id    uuid        not null references auth.users on delete cascade,
  sleep_at   timestamptz not null,
  woke_at    timestamptz,
  fajr_at    timestamptz not null,
  first_at   timestamptz not null,
  last_at    timestamptz not null,
  minutes    integer     not null check (minutes between 1 and 1440),
  kinds      text        not null default '' check (kinds in ('', 'laptop', 'phone', 'laptop,phone')),
  updated_at timestamptz not null default now(),
  primary key (user_id, sleep_at),
  constraint activity_nights_span check (last_at > first_at and first_at >= sleep_at and last_at <= fajr_at)
);

alter table public.activity_nights enable row level security;

do $$ begin
  create policy "read own nights" on public.activity_nights
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.activity_nights from anon, authenticated;

-- Teach ProBeing: names he chose to Ignore (a site, or an app as a squashed word),
-- so the Teach list stops offering them. Never a title.
alter table public.user_settings add column if not exists activity_ignore jsonb
  check (activity_ignore is null or (jsonb_typeof(activity_ignore) = 'array' and jsonb_array_length(activity_ignore) <= 300));

-- At most one open question per kind per sleep or break (ref_at is that row's
-- instant): two devices reporting at once cannot both push one.
create unique index if not exists activity_nudges_open_ask_idx on public.activity_nudges (user_id, kind, ref_at)
  where state = 'sent' and kind in ('awake', 'resume');

-- His switch for the sleep and break checks (the awake / back-to-work questions).
-- Off: no question and no push; disturbed nights are still kept.
alter table public.user_settings add column if not exists activity_checks boolean not null default true;

-- ============================================================ item 28 (12 Oct)
-- Awake with the day not started (or after End day), the devices send bare blocks
-- too (mode 'off'). Two new questions: 'start' ("didn't mark it — start?", ref_at =
-- the wake or off row that began the stretch) and 'upwork' ("Up and working?",
-- asked instead of 'awake' about the same sleep). New states: started, notwork.
-- New events rid prefix, no schema change: ns- (a resume back to the work, "Start").
-- Safe to run twice.

alter table public.activity_blocks drop constraint if exists activity_blocks_mode;
alter table public.activity_blocks add constraint activity_blocks_mode check (mode in ('work', 'break', 'sleep', 'off'));

alter table public.activity_nudges drop constraint if exists activity_nudges_kind;
alter table public.activity_nudges add constraint activity_nudges_kind
  check (kind in ('distract', 'awake', 'resume', 'upwork', 'start', 'teach', 'auto', 'idle'));   -- teach: item 29, auto: item 30b, so a re-run keeps their rows

alter table public.activity_nudges drop constraint if exists activity_nudges_state_check;
alter table public.activity_nudges add constraint activity_nudges_state_check check (state in ('sent', 'working', 'break',
  'answered', 'left', 'autobreak', 'question', 'stale', 'closed', 'awake', 'asleep', 'resumed', 'started', 'notwork',
  'asking', 'rejected', 'pending', 'applied'));

-- One open question per sleep, break or day-off stretch: "awake?" and "Up and working?"
-- about one sleep count as one. It covers item 23's index, which is dropped.
create unique index if not exists activity_nudges_open_ask28_idx on public.activity_nudges
  (user_id, (case when kind = 'upwork' then 'awake' else kind end), ref_at)
  where state = 'sent' and kind in ('awake', 'resume', 'upwork', 'start');
drop index if exists public.activity_nudges_open_ask_idx;

-- ============================================================ item 29 (12 Oct)
-- A work list ({"work": [...]} in user_settings.activity_lists; jsonb, no change): apps
-- that are work with no project. And "What is <app>?": an unsorted app or site (a name
-- from working-time blocks only; never a title, never one on his private list) at 15
-- minutes in a day is asked about, one question at a time. A question is an
-- activity_nudges row: kind 'teach', state 'asking' -> answered / closed / stale;
-- streak_start = ref_at = the counter day's start; what = the name as shown; entry = the
-- name Teach keeps (a site, or the app squashed); entry_min = its minutes when asked;
-- pushed_at set only when it was pushed (at most two a day). Written by activity-ingest
-- only. 'asking', not 'sent', so an app from before item 29 never shows it as a
-- distraction push. No new events rows. Safe to run twice.

alter table public.activity_nudges add column if not exists entry text not null default ''
  check (char_length(entry) <= 253);
alter table public.activity_nudges add column if not exists entry_min integer
  check (entry_min is null or entry_min between 0 and 1440);

alter table public.activity_nudges drop constraint if exists activity_nudges_kind;
alter table public.activity_nudges add constraint activity_nudges_kind
  check (kind in ('distract', 'awake', 'resume', 'upwork', 'start', 'teach', 'auto', 'idle'));

alter table public.activity_nudges drop constraint if exists activity_nudges_state_check;
alter table public.activity_nudges add constraint activity_nudges_state_check check (state in ('sent', 'working', 'break',
  'answered', 'left', 'autobreak', 'question', 'stale', 'closed', 'awake', 'asleep', 'resumed', 'started', 'notwork',
  'asking', 'rejected', 'pending', 'applied'));

-- One open question at a time, and each name asked at most once a day. A name he made private is
-- blanked on its rows (entry ''), so blank rows are left out of the second.
create unique index if not exists activity_nudges_open_teach_idx on public.activity_nudges (user_id)
  where kind = 'teach' and state = 'asking';
drop index if exists public.activity_nudges_teach_day_idx;
create unique index if not exists activity_nudges_teach_name_day_idx on public.activity_nudges (user_id, entry, streak_start)
  where kind = 'teach' and entry <> '';

grant select (entry, entry_min) on public.activity_nudges to authenticated;

-- His switch for the question (Settings: "Ask what an unsorted app is"). Off: no question,
-- no push; Teach ProBeing in Settings still works.
alter table public.user_settings add column if not exists activity_teach boolean not null default true;

-- Item 29 fix: a label never reaches back. When a block's category changes (a list or a rule
-- placed it later), activity-ingest stamps became_at, and the distraction, break and day checks
-- read the block as unclear before then. Written by activity-ingest only, like the block.
alter table public.activity_blocks add column if not exists became_at timestamptz;

-- An app from before item 29 saves the lists without "work": the work list he already has is kept.
create or replace function public.keep_work_list() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.activity_lists is not null and not (new.activity_lists ? 'work')
     and old.activity_lists is not null and (old.activity_lists ? 'work') then
    new.activity_lists := new.activity_lists || jsonb_build_object('work', old.activity_lists -> 'work');
  end if;
  return new;
end $$;

drop trigger if exists keep_work_list on public.user_settings;
create trigger keep_work_list before update of activity_lists on public.user_settings
  for each row execute function public.keep_work_list();

-- ============================================================ item 30a (13 Oct)
-- Focus while working, work runs and helpers. Browsers are neutral (the site decides) and
-- ProBeing's own page is not activity: the watchers decide that, no schema change. A helper
-- (terminal, Notepad, Explorer, localhost...) is a "helpers" list in user_settings.activity_lists
-- (jsonb, no change). New events rid prefixes, no schema change: nd- / ne- (a distraction inside
-- a work run, written as a break and a resume when "start?", "back to work?" or "Up and
-- working?" is answered Start / Resume). Safe to run twice.

-- The work run a question is about: {work_min, dist_min, what, gaps: [[start, end], ...]} (ISO).
-- Written by activity-ingest; read by the app so its sheet writes the same breaks.
alter table public.activity_nudges add column if not exists run jsonb
  check (run is null or jsonb_typeof(run) = 'object');
grant select (run) on public.activity_nudges to authenticated;

-- activity_focus: distractions while working, by tier: a slip (2-5 min) or a focus loss (5-15);
-- and each counter day's longest unbroken work stretch ('stretch'). A distraction is named by a
-- word only (YouTube, X... or "distraction"), never an app, site or title. Recounted by
-- activity-ingest on each run; read by the Today card, Review and the reports.
create table if not exists public.activity_focus (
  user_id    uuid        not null references auth.users on delete cascade,
  tier       text        not null check (tier in ('slip', 'loss', 'stretch')),
  start_at   timestamptz not null,
  end_at     timestamptz not null,
  day        date        not null,
  minutes    integer     not null check (minutes between 1 and 1440),
  what       text        not null default '' check (what ~ '^[A-Za-z ]{0,20}$'),
  updated_at timestamptz not null default now(),
  primary key (user_id, tier, start_at),
  constraint activity_focus_span check (end_at > start_at)
);

create index if not exists activity_focus_user_day_idx on public.activity_focus (user_id, day);

alter table public.activity_focus enable row level security;

do $$ begin
  create policy "read own focus" on public.activity_focus
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete, truncate on table public.activity_focus from anon, authenticated;

-- focus_advice: the day's one Gemini line or two (End day). The app claims the day with an empty
-- row before it asks (state 'writing'), so two devices never both spend a call; it then fills the
-- text in ('done'). A failed call leaves 'failed', and one more try (tries 2) is allowed that day.
create table if not exists public.focus_advice (
  user_id  uuid        not null default auth.uid() references auth.users on delete cascade,
  day      date        not null,
  text     text        not null default '' check (char_length(text) <= 400),
  model    text        not null default '' check (char_length(model) <= 80),
  state    text        not null default 'writing' check (state in ('writing', 'done', 'failed')),
  tries    integer     not null default 1 check (tries between 1 and 2),
  made_at  timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.focus_advice enable row level security;

do $$ begin
  create policy "read own advice" on public.focus_advice
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own advice" on public.focus_advice
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "update own advice" on public.focus_advice
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.focus_advice from anon, authenticated;
grant select on public.focus_advice to authenticated;
grant insert (user_id, day, text, state, tries, made_at) on public.focus_advice to authenticated;
grant update (text, model, state, tries, made_at) on public.focus_advice to authenticated;

-- An app from before item 30a saves the lists without "helpers" (and before 29, without "work"):
-- the lists he already has are kept.
create or replace function public.keep_work_list() returns trigger language plpgsql set search_path = '' as $$
declare k text;
begin
  if new.activity_lists is not null and old.activity_lists is not null then
    foreach k in array array['work', 'helpers'] loop
      if not (new.activity_lists ? k) and (old.activity_lists ? k) then
        new.activity_lists := new.activity_lists || jsonb_build_object(k, old.activity_lists -> k);
      end if;
    end loop;
  end if;
  return new;
end $$;

-- ============================================================ item 30b (13 Oct)
-- Virtual desktops (laptop) and auto-detected Working on. Safe to run twice.

-- The Windows virtual desktop a laptop block was on, by NAME (the tray samples it; never an id).
-- Empty on the phone, on a bare block (asleep, a break, the day off) and on a private one.
-- Written by activity-ingest only, like the block.
alter table public.activity_blocks add column if not exists desktop text not null default ''
  check (char_length(desktop) <= 80 and desktop !~ '[[:cntrl:]]');

do $$ begin
  alter table public.activity_blocks add constraint activity_blocks_bare_desktop check (mode = 'work' or desktop = '');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.activity_blocks add constraint activity_blocks_private_desktop check (category <> 'private' or desktop = '');
exception when duplicate_object then null; end $$;

-- His "Desktop name = Project" pairs (Settings -> ProBeing training -> Desktops -> project), for
-- desktops whose names are not a project's: [{"desktop": "Desktop 2", "project": "OneNet"}, ...].
alter table public.user_settings add column if not exists activity_desktops jsonb
  check (activity_desktops is null or (jsonb_typeof(activity_desktops) = 'array' and jsonb_array_length(activity_desktops) <= 30));

-- Auto-detected Working on: a project worked on (by the watchers) that is not in Working on, kept as
-- an activity_nudges row, kind 'auto' (run = {work_min, last, project, ...}; ref_at = where the
-- stretch may begin; no push, no nonce). Accept writes an events row ns-<id> (type work, project set);
-- Reject na-<id> (actanswer). New state: rejected. One open at a time. The run questions' run may
-- carry a project too (jsonb, no change).
alter table public.activity_nudges drop constraint if exists activity_nudges_kind;
alter table public.activity_nudges add constraint activity_nudges_kind
  check (kind in ('distract', 'awake', 'resume', 'upwork', 'start', 'teach', 'auto', 'idle'));

alter table public.activity_nudges drop constraint if exists activity_nudges_state_check;
alter table public.activity_nudges add constraint activity_nudges_state_check check (state in ('sent', 'working', 'break',
  'answered', 'left', 'autobreak', 'question', 'stale', 'closed', 'awake', 'asleep', 'resumed', 'started', 'notwork',
  'asking', 'rejected', 'pending', 'applied'));

create unique index if not exists activity_nudges_open_auto_idx on public.activity_nudges (user_id)
  where kind = 'auto' and state = 'sent';

-- ============================================================ item 31ab (16 Oct)
-- Judgement and the catch-up sheet (claudeWorkingDocs/plan-item31.md). activity-ingest judges every
-- gap between work (activity.js actJudge) and keeps more records; asks "Why?" about an idle gap;
-- at End day applies every unanswered recommendation. New events rid prefixes, no schema change:
-- jb- / jr- (the break and resume an applied recommendation writes), jw- (an idle gap's reason: an
-- actanswer row, detail = Prayer / Washroom / Walk / Chitchat / Food / Other / Idle; the newest
-- wins; "-auto" when End day chose it). The v41 app reads none of the new kinds or states.
-- Safe to run twice.

-- activity_focus: the day's judgement. slip / loss (a 5-15 min distraction) / stretch as before;
-- rest (earned, R1), dbreak / deserved (a distraction break, R3), low / high (focus lost, R3 / R4),
-- idle (what = the reason, R5), away (unclear), external (Chit-chat, R5).
alter table public.activity_focus drop constraint if exists activity_focus_tier_check;
alter table public.activity_focus add constraint activity_focus_tier_check check (tier in ('slip', 'loss', 'stretch',
  'rest', 'dbreak', 'deserved', 'low', 'high', 'idle', 'away', 'external'));

-- activity_nudges kind 'idle': "Why?" about an idle gap (streak_start = the gap's start, span_end = its
-- end, what = the recommended reason: 'Prayer' when one was logged in it, else ''). No device, no
-- nonce: answered in the app's sheet. State 'pending' -> answered / applied (End day) / closed (later
-- blocks filled the gap). 'pending' and 'applied' are states the v41 app never reads.
-- A run question ("start?", "back to work?", "Up and working?") still open when he ends the day is
-- 'applied' too (its recommended answer written).
alter table public.activity_nudges drop constraint if exists activity_nudges_kind;
alter table public.activity_nudges add constraint activity_nudges_kind
  check (kind in ('distract', 'awake', 'resume', 'upwork', 'start', 'teach', 'auto', 'idle'));

alter table public.activity_nudges drop constraint if exists activity_nudges_state_check;
alter table public.activity_nudges add constraint activity_nudges_state_check check (state in ('sent', 'working', 'break',
  'answered', 'left', 'autobreak', 'question', 'stale', 'closed', 'awake', 'asleep', 'resumed', 'started', 'notwork',
  'asking', 'rejected', 'pending', 'applied'));

-- One question per idle gap.
create unique index if not exists activity_nudges_idle_gap_idx on public.activity_nudges (user_id, streak_start)
  where kind = 'idle';

-- R6: how many times a question went out. "Up and working?" goes out again every hour while the work
-- goes on, three times at most; then it is applied.
alter table public.activity_nudges add column if not exists pushes integer not null default 1
  check (pushes between 1 and 10);
grant select (pushes) on public.activity_nudges to authenticated;

-- ============================================================ item 31cd (16 Oct)
-- 31c: no schema change. prayer-remind, activity-ingest and wrapup stop pushing "<prayer> logged",
-- "Noted" and "Answered on another device"; the app closes notifications that are over. The prayer
-- insert trigger still calls prayer-remind, which now just answers 'nothing'.
-- 31d: the day-end check-in after End day. Append-only, one row per Save; the newest (at) per day
-- wins, so a second Save that day, or the other device's, changes the answer without an update.
-- Written through the app's outbox with a rid fixed before the first send, so a resend is a no-op
-- on (user_id, rid). figures: the day's numbers and their judgement, worked out by the app. Safe to
-- run twice.
create table if not exists public.day_reflections (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  rid        text        not null check (char_length(rid) between 1 and 80),
  day        date        not null,
  at         timestamptz not null default now(),
  rating     smallint    check (rating between 1 and 5),
  energy     smallint    check (energy between 1 and 5),
  comment    text        not null default '' check (char_length(comment) <= 300),
  blockers   text[]      not null default '{}'
             check (blockers <@ array['tired', 'interruptions', 'unclear', 'meetings', 'phone', 'nothing']::text[]),
  tasks      jsonb       not null default '[]'
             check (jsonb_typeof(tasks) = 'array' and jsonb_array_length(tasks) <= 40 and octet_length(tasks::text) <= 16000),
  tomorrow   jsonb       not null default '[]'
             check (jsonb_typeof(tomorrow) = 'array' and jsonb_array_length(tomorrow) <= 3),
  figures    jsonb       check (figures is null or (jsonb_typeof(figures) = 'object' and octet_length(figures::text) <= 4000)),
  created_at timestamptz not null default now(),
  constraint day_reflections_rid_key unique (user_id, rid)
);

create index if not exists day_reflections_user_day_idx on public.day_reflections (user_id, day);

alter table public.day_reflections enable row level security;

do $$ begin
  create policy "read own reflections" on public.day_reflections
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own reflections" on public.day_reflections
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.day_reflections from anon, authenticated;
grant select on public.day_reflections to authenticated;
grant insert (user_id, rid, day, at, rating, energy, comment, blockers, tasks, tomorrow, figures)
  on public.day_reflections to authenticated;

-- ── Item 35a (27 Oct): "Did you make progress?" 1–5 in the day-end check-in ──
alter table public.day_reflections add column if not exists progress smallint check (progress between 1 and 5);
grant insert (progress) on public.day_reflections to authenticated;

-- ── Item 35b (27 Oct): weekly/monthly reports are read and acknowledged; a week's 3 goals ──
-- The ack lives on the report row (the update policy above covers it). Regenerating a report
-- upserts only its own columns, so an ack survives a rewrite.
alter table public.reports add column if not exists acked_at  timestamptz;
alter table public.reports add column if not exists ack_note  text not null default '' check (char_length(ack_note) <= 1000);
alter table public.reports add column if not exists goals_hit jsonb
  check (goals_hit is null or (jsonb_typeof(goals_hit) = 'array' and jsonb_array_length(goals_hit) <= 3));

-- Append-only like day_reflections: the newest row for a week wins.
create table if not exists public.week_goals (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  rid        text        not null check (char_length(rid) between 1 and 80),
  week_start date        not null,
  goals      jsonb       not null
             check (jsonb_typeof(goals) = 'array' and jsonb_array_length(goals) between 1 and 3 and octet_length(goals::text) <= 1200),
  at         timestamptz not null default now(),
  constraint week_goals_rid_key unique (user_id, rid)
);

create index if not exists week_goals_user_week_idx on public.week_goals (user_id, week_start);

alter table public.week_goals enable row level security;

do $$ begin
  create policy "read own week goals" on public.week_goals
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "insert own week goals" on public.week_goals
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

revoke all on table public.week_goals from anon, authenticated;
grant select on public.week_goals to authenticated;
grant insert (user_id, rid, week_start, goals, at) on public.week_goals to authenticated;
