-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/classify · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Stage 14a. Files typed entries under his Google tasks. Each new entry gets a
-- `pending` row in entry_filing (only while Google is connected with a list)
-- and pokes the classify function; the function waits until a batch is worth
-- one Gemini call, and the 5-minute cron catches the ones it left waiting.
-- Run the "filing (14a)" part of docs/supabase_schema.sql first. Needs pg_cron
-- and pg_net, which the wrapup job already uses. Safe to re-run.

-- One place holds the URL and headers; the cron job and the trigger both call it.
-- pg_net only queues the request, and sends it after the insert commits.
create or replace function public.classify_request(payload jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $fn$
  select net.http_post(
    url := '__FUNCTION_URL__',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Satisfies Supabase's Verify JWT gate; the secret below is the real gate.
      'Authorization', 'Bearer __BEARER__',
      'x-cron-secret', '__CRON_SECRET__'),
    body := payload,
    timeout_milliseconds := 60000);
$fn$;

-- Public schema functions are callable over the REST API; this one must not be.
revoke all on function public.classify_request(jsonb) from public, anon, authenticated;

-- A blank typed entry: mark it pending and poke the function. Never fails the
-- insert that fired it. An entry that arrives already named (Start working on
-- it, or a label from an older app) is not filed.
create or replace function public.classify_after_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  begin
    if exists (select 1 from public.sync_state s
                where s.user_id = new.user_id and s.connected
                  and s.list_id is not null and s.list_title is not null) then
      insert into public.entry_filing (user_id, entry_rid) values (new.user_id, new.rid)
        on conflict (user_id, entry_rid) do nothing;
      -- Its own block: a request that cannot be queued keeps the row for the cron.
      begin
        perform public.classify_request('{"entry": true}'::jsonb);
      exception when others then
        null;
      end;
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$fn$;

revoke all on function public.classify_after_entry() from public, anon, authenticated;

drop trigger if exists classify_after_entry on public.events;
create trigger classify_after_entry
  after insert on public.events
  for each row
  when (new.type in ('work', 'voice') and new.project = '' and new.node_id is null
        and new.rid is not null and new.raw_text <> '')
  execute function public.classify_after_entry();

-- Every 5 minutes: a run with nothing ready reads two small rows and stops.
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-classify';
select cron.schedule('probeing-classify', '*/5 * * * *',
  $job$ select public.classify_request('{}'::jsonb); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-classify';
--            select created, status_code, content from net._http_response order by created desc limit 10;
--            select state, reason, count(*) from public.entry_filing group by 1, 2;
--            select * from public.gemini_usage order by day desc limit 7;
-- To stop:   select cron.unschedule('probeing-classify');
--            drop trigger if exists classify_after_entry on public.events;
