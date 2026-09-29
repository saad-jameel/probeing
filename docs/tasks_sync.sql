-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/tasks-sync · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Stage 13. Pulls his Google Tasks list into task_nodes every 15 minutes, with
-- the app closed. Until Google is connected and a list is picked, each run
-- answers "skipped" and writes nothing. Needs pg_cron and pg_net, which the
-- `probeing-wrapup` job already uses, and task_nodes from supabase_schema.sql.
-- Safe to re-run.

-- One place holds the URL and headers, as glance_refresh_request() does.
-- pg_net only queues the request and returns.
create or replace function public.tasks_sync_request()
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
revoke all on function public.tasks_sync_request() from public, anon, authenticated;

-- The schedule. UTC, but every 15 minutes all day, so the zone does not matter.
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-tasks-sync';
select cron.schedule('probeing-tasks-sync', '*/15 * * * *',
  $job$ select public.tasks_sync_request(); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-tasks-sync';
--            select created, status_code, content from net._http_response order by created desc limit 10;
