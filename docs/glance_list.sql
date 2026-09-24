-- The widget's list of open projects (widget-list, 24 Sep 2026). Safe to re-run.
--
-- Adds `glance.lines` and makes glance_for() return it. No placeholders: nothing
-- here is secret, so this file runs as it stands.
--
-- ORDER: run this BEFORE deploying the glance-refresh that writes `lines`, or
-- its upsert fails on the missing column and the widget stops moving. The v2 APK
-- is unaffected: it reads the reply's fields by name and ignores `lines`.
--
-- One transaction, because a change of return type needs a drop first: the
-- widget must never see the function missing, or present without its grant.

begin;

alter table public.glance add column if not exists lines text not null default '';

drop function if exists public.glance_for(text);

-- The body is docs/supabase_schema.sql's, unchanged; only the return shape moved.
create function public.glance_for(secret text)
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

revoke all on function public.glance_for(text) from public;
grant execute on function public.glance_for(text) to anon, authenticated;

commit;

-- PostgREST caches function signatures; tell it this one changed.
notify pgrst, 'reload schema';

-- To check:  select * from public.glance_for('<your pairing code>');   -- 4 columns
--            select column_name from information_schema.columns
--             where table_schema = 'public' and table_name = 'glance';
