// ProBeing — the `tasks-sync` Edge Function. Stage 13.
//
// Copies his chosen Google Tasks list into task_nodes. Read-only: nothing is
// ever written to Google here. pg_cron calls it every 15 minutes with the cron
// secret (docs/tasks_sync.sql); the app calls it on open with his JWT.
//
// DORMANT until Google is connected and a list is picked: it answers
// {ok:true, skipped} and writes nothing, not even an error.
//
// A pull is believed only when it is complete. A failed or unreadable page, a
// missing list, or an empty answer against a full mirror marks NOTHING gone;
// the reason goes to sync_state.last_error instead, which Settings shows.
//
// Secrets: the Stage 12 three (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_TOKEN_KEY), CRON_SECRET and ALLOWED_USER_ID. Needs task_nodes from
// docs/supabase_schema.sql.
//
// Deployed by hand, like the others:
//   npx supabase functions deploy tasks-sync --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';
import '../_shared/google.js';
import '../_shared/tree.js';

// Classic scripts, so they hand their functions over on globalThis.
const { RECONNECT, googleConfig, importTokenKey, scrub, markReconnect, tasksGet } =
  (globalThis as unknown as { ProBeingGoogle: Record<string, any> }).ProBeingGoogle;
const { diffPull } = (globalThis as unknown as { ProBeingTree: Record<string, any> }).ProBeingTree;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/* ── Pure helpers. Plain JS with `var`, as in google-link, so a node test can
 *    lift them. Clock, network and database arrive as arguments. ─────────── */

var TASKS_LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/';
// All three flags spelled out: Google's own pages disagree on their defaults.
var PULL_QUERY = 'showCompleted=true&showHidden=true&showDeleted=true&maxResults=100';
// 20,000 tasks. A list still paging past this is not read as complete.
var MAX_PAGES = 200;
var WRITE_BATCH = 500;
var GONE_BATCH = 100;
var LIST_GONE = 'Tasks list not found — pick it again in Settings.';

function pageUrl(listId, pageToken) {
  return TASKS_LISTS_URL + encodeURIComponent(listId) + '/tasks?' + PULL_QUERY +
         (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
}

/** Plainly Google's answer to tasks.list. An HTML error page, a cut-off body
 *  or a null reaches here as {} or null, and must not read as "no tasks". */
function readablePage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.kind !== 'tasks#tasks') return false;
  if (!('items' in body)) return true;            // Google leaves items out of an empty list
  return Array.isArray(body.items) && body.items.every(function (t) {
    return t && typeof t === 'object' && typeof t.id === 'string' && t.id !== '';
  });
}

/** Every task in the list, or a throw. Never part of one. */
async function pullAll(d, grant) {
  var tasks = [];
  var page = '';
  for (var i = 0; i < MAX_PAGES; i++) {
    var body = await tasksGet(d, grant, pageUrl(grant.list_id, page));
    if (!readablePage(body)) throw new Error('page ' + (i + 1) + ' of the list came back unreadable');
    (body.items || []).forEach(function (t) { tasks.push(t); });
    page = body.nextPageToken || '';
    if (!page) return { tasks: tasks, pages: i + 1 };
  }
  throw new Error('the list is longer than ' + (MAX_PAGES * 100) + ' tasks, so it was not read whole');
}

/** The database side. `sb` is a service-role client, so every query names the user. */
function mirrorStore(sb) {
  function must(r) {
    if (r.error) throw new Error(r.error.message || 'database error');
    return r.data;
  }
  return {
    getGrant: async function (userId) {
      var rows = must(await sb.from('google_grants').select('*').eq('user_id', userId).limit(1));
      return (rows || [])[0] || null;
    },
    // An update, not an upsert, as in google-link: refresh_enc is not null.
    patchGrant: async function (userId, fields) {
      must(await sb.from('google_grants').update(fields).eq('user_id', userId));
    },
    setSync: async function (row) {
      must(await sb.from('sync_state').upsert(Object.assign({}, row,
        { updated_at: new Date().toISOString() }), { onConflict: 'user_id' }));
    },
    // Paged, because PostgREST stops at 1000 rows and a short read would hide rows from the diff.
    nodes: async function (userId) {
      var out = [];
      for (var from = 0; ; from += 1000) {
        var rows = must(await sb.from('task_nodes').select('*').eq('user_id', userId)
          .order('google_id', { ascending: true }).range(from, from + 999)) || [];
        out = out.concat(rows);
        if (rows.length < 1000) return out;
      }
    },
    // On (user_id, google_id), so the uuid is kept and two syncs at once cannot duplicate a row.
    upsertNodes: async function (userId, rows) {
      for (var i = 0; i < rows.length; i += WRITE_BATCH) {
        var batch = rows.slice(i, i + WRITE_BATCH).map(function (r) {
          return Object.assign({ user_id: userId }, r);
        });
        must(await sb.from('task_nodes').upsert(batch, { onConflict: 'user_id,google_id' }));
      }
    },
    markGone: async function (userId, ids, nowIso) {
      for (var i = 0; i < ids.length; i += GONE_BATCH) {
        must(await sb.from('task_nodes').update({ gone_at: nowIso, synced_at: nowIso })
          .eq('user_id', userId).in('id', ids.slice(i, i + GONE_BATCH)).is('gone_at', null));
      }
    }
  };
}

async function failSync(d, why) {
  try {
    await d.store.setSync({ user_id: d.userId, last_error: why,
                            last_error_at: new Date(d.now()).toISOString() });
  } catch (_e) { /* the reply still says it */ }
}

/** One pull. `d`: {cfg, key, store, userId, fetch, now}. */
async function syncTasks(d) {
  var grant = await d.store.getGrant(d.userId);
  if (!grant || !grant.list_id) return { ok: true, skipped: 'not connected' };
  var nowIso = new Date(d.now()).toISOString();

  var pull;
  try {
    pull = await pullAll(d, grant);
  } catch (e) {
    if (e && e.reconnect) {
      await markReconnect(d, e.message);
      return { ok: false, reconnect: true, error: RECONNECT + ' — ' + e.message + '.' };
    }
    var why = e && e.status === 404 ? LIST_GONE
            : 'Could not read Google Tasks, so nothing changed: ' + scrub((e && e.message) || e);
    await failSync(d, why);
    return { ok: false, error: why };
  }

  var diff;
  try {
    diff = diffPull(await d.store.nodes(d.userId), pull.tasks, nowIso);
    if (diff.refused) {
      await failSync(d, diff.refused);
      return { ok: false, error: diff.refused };
    }
    await d.store.upsertNodes(d.userId, diff.write);
    await d.store.markGone(d.userId, diff.gone, nowIso);
  } catch (e) {
    var said = 'Could not save the copy of your Tasks: ' + scrub((e && e.message) || e);
    await failSync(d, said);
    return { ok: false, error: said };
  }

  await d.store.setSync({ user_id: d.userId, last_pull_ok_at: nowIso, last_error: null,
                          last_error_at: null, deep_ignored: diff.deep });
  return { ok: true, tasks: pull.tasks.length, pages: pull.pages, added: diff.added,
           changed: diff.changed, revived: diff.revived, gone: diff.gone.length,
           deep_ignored: diff.deep };
}

/* ─────────────────────────────────────────────────────────────────────── */

/** Constant-time compare, copied from glance-refresh (the two share no module). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

/** The claims half of a JWT, unverified; getUser() does the verifying. As in gemini. */
function claims(jwt: string): Record<string, unknown> {
  try {
    const body = jwt.split('.')[1] || '';
    const pad = '='.repeat((4 - (body.length % 4)) % 4);
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + pad));
  } catch (_e) {
    return {};
  }
}

/** The signed-in user's id, or '' — the same checks as google-link. */
async function jwtUser(auth: string): Promise<string> {
  if (!/^Bearer\s+\S/i.test(auth)) return '';
  const jwt = auth.replace(/^Bearer\s+/i, '').trim();
  // The public anon key is also a valid JWT; only a signed-in user gets through.
  if (claims(jwt).role !== 'authenticated') return '';
  const sbUser = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }
  );
  try {
    const { data, error } = await sbUser.auth.getUser();
    if (!error && data && data.user) return data.user.id;
  } catch (_e) { /* unreachable auth server = not signed in */ }
  return '';
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  // Unset refuses everyone, never admits everyone.
  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) return reply(403, { ok: false, error: 'set the ALLOWED_USER_ID secret first' });

  // The scheduler proves itself with the cron secret; the app with his JWT.
  const cronSaid = req.headers.get('x-cron-secret');
  if (cronSaid !== null) {
    const secret = (Deno.env.get('CRON_SECRET') || '').trim();
    if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
    if (!sameSecret(cronSaid, secret)) return reply(401, { ok: false, error: 'not the scheduler' });
  } else {
    const who = await jwtUser(req.headers.get('Authorization') || '');
    if (!who) return reply(401, { ok: false, error: 'sign in first' });
    if (who !== owner) return reply(403, { ok: false, error: 'not your app' });
  }

  const cfg = googleConfig((name: string) => Deno.env.get(name));
  if (!cfg.configured) return reply(200, { ok: true, skipped: 'not set up' });
  let key: CryptoKey;
  try {
    key = await importTokenKey(cfg.tokenKey);
  } catch (_e) {
    // Named, never quoted, as in google-link: the parser's message could echo part of the key.
    return reply(503, { ok: false, error: 'Google setup has a problem: the token key is malformed.' });
  }

  const d = {
    cfg, key, userId: owner, fetch: fetch, now: Date.now,
    store: mirrorStore(createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } }
    ))
  };

  try {
    const out = await syncTasks(d);
    return reply(out.ok ? 200 : 502, out);
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
