-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/prayer-remind · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Prayer reminders: the function runs every minute, and right after a prayer is
-- logged (to clear that prayer's reminder on the other devices). Run the
-- prayer-reminders part of docs/supabase_schema.sql first. Needs pg_cron and
-- pg_net, which the wrapup job already uses. Safe to re-run.

-- One place holds the URL and headers; the cron job and the trigger both call it.
-- pg_net only queues the request, and sends it after the insert commits.
create or replace function public.prayer_remind_request(payload jsonb)
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
    timeout_milliseconds := 30000);
$fn$;

-- Public schema functions are callable over the REST API; this one must not be.
revoke all on function public.prayer_remind_request(jsonb) from public, anon, authenticated;

-- A failure to queue must never fail the insert that fired it.
create or replace function public.prayer_remind_after_prayer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  begin
    perform public.prayer_remind_request('{"logged": true}'::jsonb);
  exception when others then
    null;
  end;
  return null;
end;
$fn$;

revoke all on function public.prayer_remind_after_prayer() from public, anon, authenticated;

-- Per row, and only for prayers: five or so calls a day, not one per entry.
drop trigger if exists prayer_remind_after_prayer on public.events;
create trigger prayer_remind_after_prayer
  after insert on public.events
  for each row
  when (new.type = 'prayer')
  execute function public.prayer_remind_after_prayer();

-- Every minute: a 15-minute reminder needs minute precision. About 43,000 calls
-- a month against the free tier's 500,000; a run with nothing due reads one row.
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-prayer-remind';
select cron.schedule('probeing-prayer-remind', '* * * * *',
  $job$ select public.prayer_remind_request('{}'::jsonb); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-prayer-remind';
--            select created, status_code, content from net._http_response order by created desc limit 10;
--            select * from public.reminders_sent order by sent_at desc limit 20;
-- To stop:   select cron.unschedule('probeing-prayer-remind');
--            drop trigger if exists prayer_remind_after_prayer on public.events;
