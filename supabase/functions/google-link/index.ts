// ProBeing — the `google-link` Edge Function. Stage 12.
//
// Holds his Google grant (Tasks, and files ProBeing makes in Drive) on the
// server. The browser asks this function to connect, pick a list or disconnect,
// and never receives a Google token of any kind.
//
// Identity stays GitHub: this is a second, separate permission, keyed to the
// GitHub user's id, not a way of signing in.
//
// Ops, POSTed as {op, ...} with the signed-in user's JWT:
//   status      {configured, connected, email, list_id, list_title, reconnect}
//   start       Google's consent URL; a state nonce is stored as its sha256
//   finish      {code, state} from google-callback.html; exchanges the code
//   lists       his Tasks lists, [{id, title}]
//   pick        {list_id}: the one list ProBeing mirrors
//   disconnect  revokes at Google, then forgets the grant
//
// DORMANT until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_TOKEN_KEY are
// set: `status` answers {configured:false} and every other op refuses.
// GOOGLE_TOKEN_KEY is 32 random bytes, base64 (openssl rand -base64 32).
// Also reads ALLOWED_USER_ID, as `gemini` does. Needs google_grants,
// oauth_states and sync_state from docs/supabase_schema.sql.
//
// Deployed by hand, like the others:
//   npx supabase functions deploy google-link --project-ref <ref> --use-api

import { createClient } from 'jsr:@supabase/supabase-js@2';

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

/* ── Pure helpers. Plain JS with `var`, as in wrapup, so a node test can lift
 *    them out of this file. Clock, network and database arrive as arguments. ── */

var GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
var GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
var GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
var GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
var GOOGLE_LISTS_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
// Must match the Authorized redirect URI in the Cloud console exactly.
var REDIRECT_URI = 'https://saad-jameel.github.io/probeing/google-callback.html';
var TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
var DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
var GOOGLE_SCOPES = ['openid', 'email', TASKS_SCOPE, DRIVE_FILE_SCOPE];
var STATE_TTL_MS = 10 * 60 * 1000;
// A cached access token is used only while it has more than this left.
var ACCESS_SLACK_MS = 5 * 60 * 1000;
// sync_state.last_error starts with this when only a new Connect can help.
var RECONNECT = 'Reconnect Google';
var NOT_SET_UP = "Google isn't set up yet — see your to-do list";

/** The three secrets, or configured:false if any is missing. `get` reads one by name. */
function googleConfig(get) {
  var id = String(get('GOOGLE_CLIENT_ID') || '').trim();
  var secret = String(get('GOOGLE_CLIENT_SECRET') || '').trim();
  var key = String(get('GOOGLE_TOKEN_KEY') || '').trim();
  return { configured: Boolean(id && secret && key), clientId: id, clientSecret: secret,
           tokenKey: key };
}

function bytesToB64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Standard or URL-safe base64, padded or not. */
function b64ToBytes(text) {
  var s = String(text || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 random bytes, URL-safe: the state nonce sent to Google and back. */
function randomState() {
  var buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  var d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
  var out = '';
  for (var i = 0; i < d.length; i++) out += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  return out;
}

function authUrl(clientId, state) {
  var q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: state
  });
  return GOOGLE_AUTH_URL + '?' + q.toString();
}

/** The AES-GCM key. Anything but 32 bytes of base64 throws. */
async function importTokenKey(b64) {
  var raw = b64ToBytes(b64);
  if (raw.length !== 32) throw new Error('GOOGLE_TOKEN_KEY must be 32 random bytes, base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// The owner's id is bound in as associated data, so a blob moved to another row fails to open.
function tokenAad(userId) {
  return new TextEncoder().encode('probeing-google:' + String(userId || ''));
}

/** "v1:<iv>:<ciphertext>", a fresh 12-byte IV every time. */
async function sealToken(key, userId, plain) {
  var iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  var ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: tokenAad(userId) },
    key, new TextEncoder().encode(String(plain))));
  return 'v1:' + bytesToB64(iv) + ':' + bytesToB64(ct);
}

/** The token, or a reconnect error if the blob is missing, tampered or under another key. */
async function openToken(key, userId, blob) {
  var parts = String(blob || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw reconnectError('the saved permission is unreadable');
  try {
    var pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(parts[1]), additionalData: tokenAad(userId) },
      key, b64ToBytes(parts[2]));
    return new TextDecoder().decode(pt);
  } catch (_e) {
    throw reconnectError('the saved permission could not be decrypted');
  }
}

function reconnectError(why) {
  var e = new Error(why);
  e.reconnect = true;
  return e;
}

/** Take out anything token-shaped before a message leaves this function. */
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/ya29\.[0-9A-Za-z._-]+/g, '[redacted]')
    .replace(/1\/\/[0-9A-Za-z._-]+/g, '[redacted]')
    .replace(/GOCSPX-[0-9A-Za-z_-]+/g, '[redacted]');
}

function scopeList(scope) {
  return String(scope || '').split(/\s+/).filter(Boolean);
}

/** The email claim of an id_token. Not verified: it came straight from Google over TLS. */
function idTokenEmail(idToken) {
  try {
    var body = String(idToken || '').split('.')[1] || '';
    var json = new TextDecoder().decode(b64ToBytes(body));
    return String(JSON.parse(json).email || '');
  } catch (_e) {
    return '';
  }
}

/** '' if the claimed state row may finish this grant, else why not. */
function stateProblem(row, userId, nowMs) {
  if (!row || row.user_id !== userId) {
    return 'This Google link was already used, or is not yours. Press Connect Google in Settings again.';
  }
  if (!(Date.parse(row.expires_at) > nowMs)) {
    return 'This Google link is more than 10 minutes old. Press Connect Google in Settings again.';
  }
  return '';
}

/**
 * What a code exchange gave us: {error} or {scopes, refresh, access, expiresMs, idToken}.
 * `refresh` is '' when Google sent none, which it does on a re-consent.
 */
function readTokenResponse(body, nowMs) {
  if (!body || typeof body !== 'object') return { error: 'Google sent back something unreadable.' };
  if (body.error) return { error: 'Google refused: ' + scrub(body.error_description || body.error) };
  var scopes = scopeList(body.scope);
  if (scopes.indexOf(TASKS_SCOPE) === -1) {
    return { error: "Tasks permission wasn't granted — connect again and tick both boxes.", scopes: scopes };
  }
  if (!body.access_token) return { error: 'Google sent no access token.' };
  return {
    scopes: scopes,
    refresh: String(body.refresh_token || ''),
    access: String(body.access_token),
    expiresMs: nowMs + Math.max(0, Number(body.expires_in) || 0) * 1000,
    idToken: String(body.id_token || '')
  };
}

async function postForm(fetcher, url, fields) {
  var res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
  var body = await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: body };
}

/** The database side. `sb` is a service-role client, so every query names the user. */
function grantStore(sb) {
  function must(r) {
    if (r.error) throw new Error(r.error.message || 'database error');
    return r.data;
  }
  return {
    addState: async function (row) { must(await sb.from('oauth_states').insert(row)); },
    // Housekeeping: a day-old state is of no use to anyone.
    pruneStates: async function (userId, beforeIso) {
      await sb.from('oauth_states').delete().eq('user_id', userId).lt('expires_at', beforeIso);
    },
    // Marks it used and returns it in one statement, so two finishes cannot both win.
    claimState: async function (hash, userId, nowIso) {
      var rows = must(await sb.from('oauth_states').update({ used_at: nowIso })
        .eq('nonce_sha256', hash).eq('user_id', userId).is('used_at', null)
        .select('user_id, expires_at'));
      return (rows || [])[0] || null;
    },
    getGrant: async function (userId) {
      var rows = must(await sb.from('google_grants').select('*').eq('user_id', userId).limit(1));
      return (rows || [])[0] || null;
    },
    // A whole grant (refresh_enc included); columns not given, like list_id, are kept.
    saveGrant: async function (row) {
      must(await sb.from('google_grants').upsert(row, { onConflict: 'user_id' }));
    },
    // An update, not an upsert: an upsert's insert half would fail refresh_enc's not-null.
    patchGrant: async function (userId, fields) {
      must(await sb.from('google_grants').update(fields).eq('user_id', userId));
    },
    deleteGrant: async function (userId) {
      must(await sb.from('google_grants').delete().eq('user_id', userId));
    },
    getSync: async function (userId) {
      var rows = must(await sb.from('sync_state').select('last_error').eq('user_id', userId).limit(1));
      return (rows || [])[0] || null;
    },
    setSync: async function (row) {
      must(await sb.from('sync_state').upsert(Object.assign({}, row,
        { updated_at: new Date().toISOString() }), { onConflict: 'user_id' }));
    }
  };
}

/* Each op takes `d`: {cfg, key, store, userId, fetch, now}. */

async function markReconnect(d, why) {
  try {
    await d.store.setSync({ user_id: d.userId, last_error: RECONNECT + ': ' + why,
                            last_error_at: new Date(d.now()).toISOString() });
  } catch (_e) { /* the reply still says it */ }
}

async function startGrant(d) {
  var state = randomState();
  var now = d.now();
  await d.store.pruneStates(d.userId, new Date(now - 86400000).toISOString()).catch(function () {});
  await d.store.addState({ nonce_sha256: await sha256Hex(state), user_id: d.userId,
                           expires_at: new Date(now + STATE_TTL_MS).toISOString() });
  return { ok: true, url: authUrl(d.cfg.clientId, state) };
}

async function finishGrant(d, code, state) {
  if (!code || !state) return { ok: false, error: 'Google did not send a code back. Try Connect Google again.' };
  var now = d.now();
  var row = await d.store.claimState(await sha256Hex(state), d.userId, new Date(now).toISOString());
  var bad = stateProblem(row, d.userId, now);
  if (bad) return { ok: false, error: bad };

  var got;
  try {
    got = await postForm(d.fetch, GOOGLE_TOKEN_URL, {
      code: String(code), client_id: d.cfg.clientId, client_secret: d.cfg.clientSecret,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach Google: ' + scrub(e && e.message) };
  }
  var t = readTokenResponse(got.body, now);
  if (t.error) return { ok: false, error: t.error };

  var email = idTokenEmail(t.idToken);
  if (!email) {
    try {
      var who = await d.fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: 'Bearer ' + t.access } });
      var wb = await who.json().catch(function () { return null; });
      email = String((wb && wb.email) || '');
    } catch (_e) { /* shown blank; the grant still works */ }
  }

  // No refresh token on a re-consent: keep the one already stored, never blank it.
  // Only for the same Google account, or the old token would sit under a new name.
  var old = await d.store.getGrant(d.userId);
  var sameAccount = !old || !old.google_email || !email || old.google_email === email;
  var refreshEnc = t.refresh ? await sealToken(d.key, d.userId, t.refresh)
                             : (sameAccount && old && old.refresh_enc) || '';
  if (!refreshEnc) {
    return { ok: false, error: 'Google did not give ProBeing lasting access. Reconnect: remove ProBeing ' +
             'at myaccount.google.com/permissions, then press Connect Google again.' };
  }

  var stamp = new Date(now).toISOString();
  var grantRow = {
    user_id: d.userId, google_email: email, scopes: t.scopes, refresh_enc: refreshEnc,
    access_enc: await sealToken(d.key, d.userId, t.access),
    access_expires_at: new Date(t.expiresMs).toISOString(), connected_at: stamp, updated_at: stamp
  };
  // A list belongs to one Google account; another account starts with none.
  if (!sameAccount) { grantRow.list_id = null; grantRow.list_title = null; }
  await d.store.saveGrant(grantRow);
  await d.store.setSync({ user_id: d.userId, connected: true, google_email: email,
                          list_title: (sameAccount && old && old.list_title) || null,
                          last_error: null, last_error_at: null });
  return { ok: true, email: email, scopes: t.scopes };
}

/** A usable access token: the cached one, or one fresh from the refresh token. */
async function accessToken(d, grant, force) {
  var left = Date.parse(grant.access_expires_at || '') - d.now();
  if (!force && grant.access_enc && left > ACCESS_SLACK_MS) {
    try { return await openToken(d.key, d.userId, grant.access_enc); } catch (_e) { /* refresh below */ }
  }
  var refresh = await openToken(d.key, d.userId, grant.refresh_enc);
  var got = await postForm(d.fetch, GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token', refresh_token: refresh,
    client_id: d.cfg.clientId, client_secret: d.cfg.clientSecret
  });
  var b = got.body || {};
  if (b.error === 'invalid_grant') throw reconnectError('Google no longer accepts the permission');
  if (!got.ok || !b.access_token) {
    throw new Error('Google would not renew access: ' + scrub(b.error_description || b.error || got.status));
  }
  var now = d.now();
  var patch = { access_enc: await sealToken(d.key, d.userId, b.access_token),
                access_expires_at: new Date(now + (Number(b.expires_in) || 0) * 1000).toISOString(),
                updated_at: new Date(now).toISOString() };
  if (b.refresh_token) patch.refresh_enc = await sealToken(d.key, d.userId, b.refresh_token);
  await d.store.patchGrant(d.userId, patch);
  Object.assign(grant, patch);
  return String(b.access_token);
}

/** GET a Tasks URL; a 401 gets one forced refresh, a lost scope means reconnect. */
async function tasksGet(d, grant, url) {
  var token = await accessToken(d, grant, false);
  var res = await d.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    token = await accessToken(d, grant, true);
    res = await d.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  }
  var body = await res.json().catch(function () { return null; });
  if (res.ok) return body || {};
  var said = JSON.stringify(body || {});
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used/.test(said)) {
    throw new Error('The Google Tasks API is not enabled in the Cloud project.');
  }
  // Google answers a rate limit with 403 too; that is not a lost permission.
  if (/rateLimit|RATE_LIMIT|quota/i.test(said)) throw new Error('Google Tasks is busy; try again in a minute.');
  if (res.status === 401 || res.status === 403) throw reconnectError('Google refused the Tasks permission');
  throw new Error('Google Tasks answered ' + res.status + ': ' +
                  scrub(body && body.error && body.error.message));
}

async function taskLists(d, grant) {
  var out = [];
  var page = '';
  for (var i = 0; i < 3; i++) {
    var body = await tasksGet(d, grant, GOOGLE_LISTS_URL + '?maxResults=1000' +
                              (page ? '&pageToken=' + encodeURIComponent(page) : ''));
    (body.items || []).forEach(function (l) {
      if (l && l.id) out.push({ id: String(l.id), title: String(l.title || '') });
    });
    page = body.nextPageToken || '';
    if (!page) break;
  }
  return out;
}

/** Runs `fn(grant)`; a reconnect error is written to sync_state and said plainly. */
async function withGrant(d, fn) {
  var grant = await d.store.getGrant(d.userId);
  if (!grant) return { ok: false, error: 'Google is not connected.' };
  try {
    return await fn(grant);
  } catch (e) {
    if (e && e.reconnect) {
      await markReconnect(d, e.message);
      return { ok: false, reconnect: true, error: RECONNECT + ' — ' + e.message + '.' };
    }
    return { ok: false, error: scrub((e && e.message) || e) };
  }
}

async function listLists(d) {
  return withGrant(d, async function (grant) {
    return { ok: true, lists: await taskLists(d, grant) };
  });
}

/** The title is Google's, not the caller's: the id is looked up first. */
async function pickList(d, listId) {
  var id = String(listId || '').trim();
  if (!id) return { ok: false, error: 'Choose a list.' };
  return withGrant(d, async function (grant) {
    var hit = (await taskLists(d, grant)).filter(function (l) { return l.id === id; })[0];
    if (!hit) return { ok: false, error: 'That list is not in your Google Tasks any more.' };
    await d.store.patchGrant(d.userId, { list_id: hit.id, list_title: hit.title,
                                         updated_at: new Date(d.now()).toISOString() });
    await d.store.setSync({ user_id: d.userId, list_title: hit.title });
    return { ok: true, list_id: hit.id, list_title: hit.title };
  });
}

/** Revoke at Google, then forget the grant — even when Google's revoke fails. */
async function disconnectGrant(d) {
  var grant = await d.store.getGrant(d.userId);
  var revoked = false;
  if (grant) {
    var token = '';
    try { token = await openToken(d.key, d.userId, grant.refresh_enc); } catch (_e) {
      try { token = await openToken(d.key, d.userId, grant.access_enc); } catch (_e2) { /* nothing to revoke */ }
    }
    if (token) {
      try { revoked = (await postForm(d.fetch, GOOGLE_REVOKE_URL, { token: token })).ok; } catch (_e) { /* said below */ }
    }
    await d.store.deleteGrant(d.userId);
  }
  await d.store.setSync({ user_id: d.userId, connected: false, google_email: null, list_title: null,
                          last_error: null, last_error_at: null });
  if (!grant || revoked) return { ok: true, revoked: revoked };
  return { ok: true, revoked: false,
           note: "Disconnected here, but Google didn't confirm. To be sure, remove ProBeing at " +
                 'myaccount.google.com/permissions.' };
}

/** What Settings shows. No token, and no encrypted blob either. */
async function grantStatus(d) {
  var g = await d.store.getGrant(d.userId);
  if (!g) return { ok: true, configured: true, connected: false };
  var s = await d.store.getSync(d.userId).catch(function () { return null; });
  return { ok: true, configured: true, connected: true, email: g.google_email || '',
           scopes: g.scopes || [], list_id: g.list_id || '', list_title: g.list_title || '',
           reconnect: Boolean(s && String(s.last_error || '').indexOf(RECONNECT) === 0) };
}

/* ─────────────────────────────────────────────────────────────────────── */

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

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  // The same four checks as gemini: a bearer token, role authenticated (the
  // public anon key is also a valid JWT), a real user, and the pinned owner.
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S/i.test(auth)) return reply(401, { ok: false, error: 'sign in first' });
  const jwt = auth.replace(/^Bearer\s+/i, '').trim();
  if (claims(jwt).role !== 'authenticated') {
    return reply(401, { ok: false, error: 'not a signed-in user' });
  }
  const sbUser = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }
  );
  let user: { id: string } | null = null;
  try {
    const { data, error } = await sbUser.auth.getUser();
    if (!error && data && data.user) user = data.user;
  } catch (_e) { /* unreachable auth server = not signed in */ }
  if (!user) return reply(401, { ok: false, error: 'sign in first' });
  // Unset refuses everyone, never admits everyone.
  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) return reply(403, { ok: false, error: 'set the ALLOWED_USER_ID secret first' });
  if (user.id !== owner) return reply(403, { ok: false, error: 'not your app' });

  let sent: Record<string, unknown> = {};
  try { sent = (await req.json()) || {}; } catch (_e) { /* an empty op, refused below */ }
  const op = String(sent.op || '');

  const cfg = googleConfig((name: string) => Deno.env.get(name));
  if (!cfg.configured) {
    if (op === 'status') return reply(200, { ok: true, configured: false });
    return reply(503, { ok: false, configured: false, error: NOT_SET_UP });
  }
  let key: CryptoKey;
  try {
    key = await importTokenKey(cfg.tokenKey);
  } catch (e) {
    const why = (e as Error).message;
    if (op === 'status') return reply(200, { ok: true, configured: false, error: why });
    return reply(503, { ok: false, configured: false, error: why });
  }

  const d = {
    cfg, key, userId: user.id, fetch: fetch, now: Date.now,
    store: grantStore(createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false } }
    ))
  };

  try {
    let out: Record<string, unknown>;
    if (op === 'status') out = await grantStatus(d);
    else if (op === 'start') out = await startGrant(d);
    else if (op === 'finish') out = await finishGrant(d, String(sent.code || ''), String(sent.state || ''));
    else if (op === 'lists') out = await listLists(d);
    else if (op === 'pick') out = await pickList(d, sent.list_id);
    else if (op === 'disconnect') out = await disconnectGrant(d);
    else return reply(400, { ok: false, error: 'unknown op' });
    return reply(out.ok ? 200 : 400, out);
  } catch (e) {
    return reply(500, { ok: false, error: scrub((e as Error)?.message || e) });
  }
});
