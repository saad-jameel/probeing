-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/glance-refresh · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Keeps the widget's `glance` row current without the app open: every 10
-- minutes, and right after each new event. Needs pg_cron and pg_net, which the
-- `probeing-wrapup` job already uses. Safe to re-run.

-- One place holds the URL and headers; the cron job and the trigger both call it.
-- pg_net only queues the request and returns, so an insert never waits on it.
create or replace function public.glance_refresh_request()
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
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
$fn$;

-- Public schema functions are callable over the REST API; this one must not be.
revoke all on function public.glance_refresh_request() from public, anon, authenticated;

-- The trigger. A failure to queue must never fail the insert that fired it.
create or replace function public.glance_refresh_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  begin
    perform public.glance_refresh_request();
  exception when others then
    null;
  end;
  return null;
end;
$fn$;

-- Per statement, not per row: one insert of several rows is one refresh.
-- INSERT OR UPDATE: Gemini's name for an entry lands seconds after the entry, as
-- an UPDATE. Insert-only refreshed in that gap and showed the raw sentence on the
-- widget until the next 10-minute run (seen 24 Sep, "In ProBeing I will be…").
drop trigger if exists glance_refresh_after_insert on public.events;
drop trigger if exists glance_refresh_after_write on public.events;
create trigger glance_refresh_after_write
  after insert or update on public.events
  for each statement
  execute function public.glance_refresh_after_insert();

-- The schedule. UTC, but every 10 minutes all day, so the zone does not matter.
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-glance-refresh';
select cron.schedule('probeing-glance-refresh', '*/10 * * * *',
  $job$ select public.glance_refresh_request(); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-glance-refresh';
--            select created, status_code, content from net._http_response order by created desc limit 10;
