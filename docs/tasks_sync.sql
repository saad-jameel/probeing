-- TEMPLATE: replace __FUNCTION_URL__, __BEARER__ and __CRON_SECRET__ before running, and never commit the filled-in copy.
-- __FUNCTION_URL__ = https://<ref>.supabase.co/functions/v1/tasks-sync · __BEARER__ = the anon key · __CRON_SECRET__ = ~/.probeing/cron_secret.txt
--
-- Stage 13. Pulls his Google Tasks list into task_nodes every 15 minutes, with
-- the app closed. Until Google is connected and a list is picked, each run
-- answers "skipped" and writes nothing. Needs pg_cron and pg_net, which the
-- `probeing-wrapup` job already uses, and task_nodes from supabase_schema.sql.
-- Stage 15: a Done/Drop/Undo or a changed finish date asks for a sync at once,
-- so it reaches Google within seconds. Run the "write-back (15)" part of
-- supabase_schema.sql first. Safe to re-run.

-- One place holds the URL and headers; the cron job and the triggers call it.
-- pg_net only queues the request, and sends it after the insert commits.
-- Stage 13's version took no payload; the old one is dropped so a call with
-- none is not ambiguous.
drop function if exists public.tasks_sync_request();
create or replace function public.tasks_sync_request(payload jsonb default '{}'::jsonb)
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
revoke all on function public.tasks_sync_request(jsonb) from public, anon, authenticated;

-- A change ProBeing may have to send. Counted in tasks_sync_wants; a request
-- goes out only when none is out already (or the last is over 2 minutes old,
-- a run that died), so a burst of taps is one sync: the run goes round again
-- for taps that came in while it worked. Only while Google is connected with a
-- list. Never fails the insert or update that fired it.
create or replace function public.tasks_sync_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  go boolean;
begin
  begin
    if exists (select 1 from public.sync_state s
                where s.user_id = new.user_id and s.connected
                  and s.list_id is not null and s.list_title is not null) then
      insert into public.tasks_sync_wants as w (user_id, wanted_n, wanted_at)
        values (new.user_id, 1, now())
        on conflict (user_id) do update set wanted_n = w.wanted_n + 1, wanted_at = now();
      update public.tasks_sync_wants set sent_at = now()
       where user_id = new.user_id and (sent_at is null or sent_at < now() - interval '2 minutes')
      returning true into go;
      if go then
        -- Its own block: a request that cannot be queued leaves the next tap free to try.
        begin
          perform public.tasks_sync_request('{"poke": true}'::jsonb);
        exception when others then
          update public.tasks_sync_wants set sent_at = null where user_id = new.user_id;
        end;
      end if;
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$fn$;

revoke all on function public.tasks_sync_after_change() from public, anon, authenticated;

-- Every mark: the last Done under a task may finish it.
drop trigger if exists tasks_sync_after_mark on public.item_marks;
create trigger tasks_sync_after_mark
  after insert on public.item_marks
  for each row
  execute function public.tasks_sync_after_change();

-- Feedback 1: Done or Reopen pressed on a sub-task itself (rid sdd-/sdo-, see tree.js).
drop trigger if exists tasks_sync_after_direct on public.events;
create trigger tasks_sync_after_direct
  after insert on public.events
  for each row
  when (new.type in ('subdone', 'subopen') and new.node_id is not null
        and (new.rid like 'sdd-%' or new.rid like 'sdo-%'))
  execute function public.tasks_sync_after_change();

-- A finish date set, changed or cleared becomes Google's due date. Planned
-- on or off sends nothing.
drop trigger if exists tasks_sync_after_plan_insert on public.task_plans;
create trigger tasks_sync_after_plan_insert
  after insert on public.task_plans
  for each row
  when (new.expected_at is not null)
  execute function public.tasks_sync_after_change();
drop trigger if exists tasks_sync_after_plan_update on public.task_plans;
create trigger tasks_sync_after_plan_update
  after update of expected_at on public.task_plans
  for each row
  when (old.expected_at is distinct from new.expected_at)
  execute function public.tasks_sync_after_change();

-- The schedule. UTC, but every 15 minutes all day, so the zone does not matter.
select cron.unschedule(jobid) from cron.job where jobname = 'probeing-tasks-sync';
select cron.schedule('probeing-tasks-sync', '*/15 * * * *',
  $job$ select public.tasks_sync_request(); $job$);

-- To check:  select * from cron.job where jobname = 'probeing-tasks-sync';
--            select created, status_code, content from net._http_response order by created desc limit 10;
--            select * from public.tasks_sync_wants;
-- Before the first Stage 15 run, the sub-tasks it will tick in Google (finished
-- in ProBeing: every item closed, at least one Done). Projects are never ticked:
--   with latest as (select distinct on (item_rid) item_rid, mark, at from public.item_marks
--                   order by item_rid, at desc, created_at desc, rid desc)
--   select n.title from public.task_nodes n
--    where n.kind = 'subtask' and n.gone_at is null and n.g_status = 'needsAction'
--      and n.list_id = (select list_id from public.google_grants limit 1)
--      and not exists (select 1 from public.task_nodes p where p.google_id = n.parent_google_id
--                       and p.list_id = n.list_id and p.gone_at is not null)
--      and exists (select 1 from public.items i join latest l on l.item_rid = i.rid
--                   where i.node_id = n.id and l.mark = 'done')
--      and not exists (select 1 from public.items i left join latest l on l.item_rid = i.rid
--                       where i.node_id = n.id and coalesce(l.mark, 'open') = 'open')
--      and (n.g_reopened_at is null or (select max(l.at) from public.items i join latest l
--                                       on l.item_rid = i.rid where i.node_id = n.id) > n.g_reopened_at);
-- To stop the write-back pokes (the 15-minute sync still sends):
--            drop trigger if exists tasks_sync_after_mark on public.item_marks;
--            drop trigger if exists tasks_sync_after_direct on public.events;
--            drop trigger if exists tasks_sync_after_plan_insert on public.task_plans;
--            drop trigger if exists tasks_sync_after_plan_update on public.task_plans;
