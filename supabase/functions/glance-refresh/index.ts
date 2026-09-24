// ProBeing — the `glance-refresh` Edge Function.
//
// Owns the widget's words: recounts today and rewrites the `glance` row.
// `lines` needs the column docs/glance_list.sql adds — run that SQL before deploying this.
// pg_cron calls it every 10 minutes and an insert trigger after every new row
// (docs/glance_refresh.sql), so the widget moves while the app is closed.
// Devices no longer write that row, so an out-of-date one cannot overwrite it.
//
// The counting is supabase/functions/_shared/day.js — the file the browser
// loads — so the widget and the notification shade cannot count differently.
//
// Deployed by hand, like `wrapup`:
//   npx supabase functions deploy glance-refresh --project-ref <ref>
//
// Secrets: none new. CRON_SECRET and ALLOWED_USER_ID are the ones `wrapup`
// already reads; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the platform.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/day.js';

// day.js is a classic script, so it hands its functions over on globalThis.
const Day = (globalThis as unknown as { ProBeingDay: {
  dayFigures: (log: unknown[], prayers: unknown[], endMs?: number, carry?: unknown[]) => unknown;
  glanceText: (figures: unknown, asOfMs: number, offsetMin?: number) => { title: string; body: string };
  glanceList: (log: unknown[], endMs?: number) => string;
} }).ProBeingDay;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/* ── Pure helpers. Plain JS with `var`, as in wrapup, so a node test can lift
 *    them out of this file without a TypeScript parser. ─────────────────── */

/* Karachi is UTC+5 with no daylight saving; wrapup uses the same constant. */
var TZ_OFFSET_MIN = 300;

/* The rows that move the work or sleep state — what the browser's `carry` reads. */
var STATE_TYPES = ['sleep', 'wake', 'break', 'resume', 'off', 'work', 'voice'];

/** Local midnight in Karachi, as an instant in ms, for the day containing `ms`. */
function localDayStartMs(ms) {
  var dayMs = 86400000;
  var shifted = ms + TZ_OFFSET_MIN * 60000;
  return shifted - (((shifted % dayMs) + dayMs) % dayMs) - TZ_OFFSET_MIN * 60000;
}

/** Split events rows the way callSupabase('today') does: prayers apart, the
 *  rest in the shape replayDay() reads. Order is kept (newest first). */
function splitToday(rows) {
  var log = [];
  var prayers = [];
  (rows || []).forEach(function (r) {
    if (r.type === 'prayer') {
      prayers.push({ at: r.at, local: r.local_time || '',
                     prayer: r.project || '', mode: r.detail || '' });
    } else {
      log.push({ at: r.at, local: r.local_time || '', type: r.type,
                 raw_text: r.raw_text || '', project: r.project || '',
                 detail: r.detail || '' });
    }
  });
  return { log: log, prayers: prayers };
}

/* ─────────────────────────────────────────────────────────────────────── */

/** Constant-time compare, copied from wrapup (the two share no module). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

/** The service client. It bypasses row level security, so writes name user_id. */
function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false } }
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  const secret = (Deno.env.get('CRON_SECRET') || '').trim();
  if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
  if (!sameSecret(req.headers.get('x-cron-secret') || '', secret)) {
    return reply(401, { ok: false, error: 'not the scheduler' });
  }

  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) {
    return reply(403, { ok: false,
      error: 'this function is not pinned to an owner yet: set ALLOWED_USER_ID' });
  }

  // Taken before the reads, so "as of" can only be earlier than what they cover.
  const now = Date.now();
  const dayStart = new Date(localDayStartMs(now)).toISOString();
  const sb = admin();

  // created_at breaks ties on `at`, so newest-first really is append order.
  const todayRes = await sb.from('events')
    .select('at, local_time, type, raw_text, project, detail')
    .eq('user_id', owner).gte('at', dayStart)
    .order('at', { ascending: false }).order('created_at', { ascending: false })
    .limit(1000);
  if (todayRes.error) return reply(500, { ok: false, error: todayRes.error.message });

  // Failing here, unlike in the browser: a missing carry would print "Not started yet"
  // over a day left open from last night.
  const carryRes = await sb.from('events')
    .select('at, type')
    .eq('user_id', owner).lt('at', dayStart).in('type', STATE_TYPES)
    .order('at', { ascending: false })
    .limit(12);
  if (carryRes.error) return reply(500, { ok: false, error: carryRes.error.message });

  const split = splitToday(todayRes.data || []);
  const figures = Day.dayFigures(split.log, split.prayers, now, carryRes.data || []);
  const text = Day.glanceText(figures, now, TZ_OFFSET_MIN);
  // The widget's list of open projects; the notification shade keeps title and body.
  const lines = Day.glanceList(split.log, now);

  const stamp = new Date(now).toISOString();
  const up = await sb.from('glance').upsert({
    user_id: owner,
    title: text.title,
    body: text.body,
    lines: lines,
    as_of: stamp,
    updated_at: stamp
  }, { onConflict: 'user_id' });
  if (up.error) return reply(500, { ok: false, error: up.error.message });

  return reply(200, { ok: true, title: text.title, body: text.body });
});
