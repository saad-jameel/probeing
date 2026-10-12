-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/sheets-export · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Stage 18. Rewrites the Google Sheet copy once a day at 12:00 Karachi, when no
-- night job runs. Until Google is connected each run answers "skipped" and
-- writes nothing. Needs pg_cron and pg_net, which the other jobs already use,
-- and the "sheets copy (18)" part of supabase_schema.sql. Safe to re-run.

create or replace function public.sheets_export_request()
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
    -- A whole rewrite takes longer than a pull.
    timeout_milliseconds := 120000);
$fn$;

-- Public schema functions are callable over the REST API; this one must not be.
revoke all on function public.sheets_export_request() from public, anon, authenticated;

-- 07:00 UTC is 12:00 in Karachi (no daylight saving there).
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-sheets-export';
select cron.schedule('probeing-sheets-export', '0 7 * * *',
  $job$ select public.sheets_export_request(); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-sheets-export';
--            select created, status_code, content from net._http_response order by created desc limit 10;
--            select sheet_url, last_export_at, export_error, sheet_note from public.sync_state;
-- To stop:   select cron.unschedule(jobid) from cron.job where jobname = 'probeing-sheets-export';
