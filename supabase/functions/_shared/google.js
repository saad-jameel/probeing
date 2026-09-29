/* ProBeing — the Google grant helpers, shared by google-link and tasks-sync.
 *
 * Server-only. A classic script like day.js (no import/export, strict-safe),
 * so a node test can lift these by name. The two functions import it and read
 * the helpers off globalThis.ProBeingGoogle. Clock, network and database
 * arrive as arguments.
 */

'use strict';

var GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// A cached access token is used only while it has more than this left.
var ACCESS_SLACK_MS = 5 * 60 * 1000;

// sync_state.last_error starts with this when only a new Connect can help.
var RECONNECT = 'Reconnect Google';

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

async function postForm(fetcher, url, fields) {
  var res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
  var body = await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: body };
}

async function markReconnect(d, why) {
  try {
    await d.store.setSync({ user_id: d.userId, last_error: RECONNECT + ': ' + why,
                            last_error_at: new Date(d.now()).toISOString() });
  } catch (_e) { /* the reply still says it */ }
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
  var e = new Error('Google Tasks answered ' + res.status + ': ' +
                    scrub(body && body.error && body.error.message));
  e.status = res.status;
  throw e;
}

globalThis.ProBeingGoogle = {
  GOOGLE_TOKEN_URL: GOOGLE_TOKEN_URL,
  ACCESS_SLACK_MS: ACCESS_SLACK_MS,
  RECONNECT: RECONNECT,
  googleConfig: googleConfig,
  bytesToB64: bytesToB64,
  b64ToBytes: b64ToBytes,
  importTokenKey: importTokenKey,
  tokenAad: tokenAad,
  sealToken: sealToken,
  openToken: openToken,
  reconnectError: reconnectError,
  scrub: scrub,
  postForm: postForm,
  markReconnect: markReconnect,
  accessToken: accessToken,
  tasksGet: tasksGet
};
