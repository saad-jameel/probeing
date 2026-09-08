// ProBeing — the `wrapup` Edge Function. Stage 7a.
//
// One job, at 11:30 PM: if the day was never closed, ask "are you awake?" as a
// real push notification, wait an hour, and if nothing comes back, close the day
// AS OF THE MOMENT THE QUESTION WENT OUT. Not as of when the hour ran out — if
// he did not answer at 11:30 he was asleep at 11:30, and closing at 00:30 would
// add an hour of phantom wakefulness to every unanswered night.
//
// It is also the only thing in ProBeing a service worker can talk to, which is
// why the answer path below takes a NONCE rather than a login: the Supabase
// session lives in localStorage, and a service worker cannot read localStorage.
//
// NO GEMINI HERE, and that is a decision rather than an omission. The free tier
// is 20 calls a DAY, the counter that rations them lives in the browser's own
// localStorage, and a nightly server-side call would be invisible to it — the
// app would discover the shortfall as a refusal in the middle of the afternoon.
// Its two outputs are a push and an event row; neither is prose.
//
// Deployed by hand; the repo stays the source of truth:
//   npx supabase secrets set CRON_SECRET=... VAPID_PRIVATE_KEY=... --project-ref <ref>
//   npx supabase functions deploy wrapup --project-ref <ref>
//
// THE REPO CANNOT PROVE WHAT IS RUNNING HERE — the same hole `gemini` already
// has, and the same rule: every functional change to this file is dead until
// somebody pastes it into the dashboard and presses Deploy.
//
// Secrets it needs (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
// are injected by the platform):
//   CRON_SECRET        the shared secret pg_cron sends in x-cron-secret
//   VAPID_PRIVATE_KEY  base64url PKCS#8, from scripts/make_vapid.js
//   ALLOWED_USER_ID    the one account this runs for — the same secret `gemini`
//                      already uses, so there is nothing new to set
//   VAPID_SUBJECT      optional; a contact URL the push service can complain to

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE DECISION, AND NOTHING ELSE.
 *
 * Everything between here and the next banner is pure: it reads no clock, no
 * database and no environment. `now` arrives as an argument, which is the house
 * style (`reportRangeOf(period, now)`, `sleepClosingRow(work, night)`) and is
 * what makes the 11:30 PM behaviour testable at 4 in the afternoon —
 * claudeWorkingDocs/tests/wrapup.js lifts this block verbatim and runs it.
 *
 * WRITTEN IN PLAIN JAVASCRIPT, WITH `var`, INSIDE A .ts FILE. Deliberate: the
 * test lifts these declarations out of this file by matching braces, the same
 * way the other suites lift out of app.js, and plain node cannot parse a
 * TypeScript type annotation. A test that re-implements the rule instead of
 * lifting it passes forever while the code changes underneath it.
 * ──────────────────────────────────────────────────────────────────────────── */

/* Pakistan is UTC+5 and has had no daylight saving since 2009, so a fixed
 * offset is not the usual lie it would be anywhere else — and it is what keeps
 * the block above pure, since asking Intl for a zone is a lookup, not
 * arithmetic. `backend/appsscript.json` names the same zone. */
var TZ_OFFSET_MIN = 300;

/** 11:30 PM, as minutes past local midnight. The hour the whole stage is about. */
var WRAP_AT_MIN = 23 * 60 + 30;

/** 5 AM — where the night stops. Past this, a day still left open is left open:
 *  a "are you awake?" at 7 in the morning answers a question nobody asked. The
 *  same boundary app.js calls DAY_STARTS_HOUR. */
var NIGHT_ENDS_MIN = 5 * 60;

/** How long a question waits for its answer before silence counts as "asleep". */
var ANSWER_WINDOW_MS = 60 * 60000;

/* The gap between one check and the next when the last one WAS answered. The
 * spec names two times — 11:30 PM and 1:00 AM — and this is the gap between
 * them. Measured from when the question went out, not from when he answered:
 * tapping Yes at 11:31 and tapping it at 00:29 are the same fact, and the next
 * question should not move an hour because his thumb was slow. */
var NEXT_CHECK_MS = 90 * 60000;

/** The two row types that mean the day is over. Anything else — work, voice,
 *  resume, break, wake — means it is still running. */
var DAY_IS_CLOSED_BY = { off: 1, sleep: 1 };

/** Minutes past local midnight, for an instant given in milliseconds. */
function localMinuteOfDay(ms) {
  var mins = Math.floor(ms / 60000) + TZ_OFFSET_MIN;
  return ((mins % 1440) + 1440) % 1440;
}

/** Is this instant inside the window where a check may be SENT? Closing a day
 *  is not gated on it — a question asked at 4:30 AM still deserves its answer
 *  at 5:30. */
function inCheckWindow(ms) {
  var m = localMinuteOfDay(ms);
  return m >= WRAP_AT_MIN || m < NIGHT_ENDS_MIN;
}

/**
 * What the wrapup should do right now.
 *
 * @param last  the newest state row, `{type, at}` with `at` in milliseconds, or
 *              null when the account has none. Null means nothing: an account
 *              with no rows is not evidence that somebody is awake, and closing
 *              a day that never opened writes a sleep nobody slept.
 * @param open  the newest unresolved check, `{sentAt, answeredAt}` in
 *              milliseconds (`answeredAt` 0 or null when it is still waiting),
 *              or null when there is none.
 * @param now   the instant to decide at, in milliseconds.
 *
 * @returns `{act, at, resolve, why}` where `act` is one of:
 *            'nothing' — leave it alone
 *            'check'   — send "are you awake?" and record it
 *            'close'   — write the day's closing rows, stamped `at`
 *          `resolve` says whether the open check is finished with. `why` is a
 *          sentence for the reply, because a scheduled job nobody watches has
 *          to be able to explain itself after the fact.
 */
function shouldWrapUp(last, open, now) {
  var dayOpen = Boolean(last && !DAY_IS_CLOSED_BY[last.type]);

  if (open) {
    /* He closed the day himself while the question was in the air — pressed
     * Sleep, or ended the day on the laptop. The question is moot, and writing
     * a second `off` an hour later would put a closing edge after the real one. */
    if (!dayOpen) {
      return { act: 'nothing', at: 0, resolve: true,
               why: 'the day was closed another way while the check was open' };
    }

    if (open.answeredAt) {
      if (now >= open.sentAt + NEXT_CHECK_MS && inCheckWindow(now)) {
        return { act: 'check', at: now, resolve: true,
                 why: 'the last check was answered and the next one is due' };
      }
      return { act: 'nothing', at: 0, resolve: false,
               why: 'answered; the next check is not due yet' };
    }

    if (now >= open.sentAt + ANSWER_WINDOW_MS) {
      /* THE POINT OF THE WHOLE STAGE: the day ends when the question went out,
       * not when the hour ran out.
       *
       * With one correction, for the case where he ignored the notification and
       * carried on working: a closing edge may never predate the last thing that
       * actually happened, or the review sees a day that ended before its own
       * last row. And never past `now`, for the same reason replayDay() refuses
       * to credit the future — a device clock running ahead would otherwise
       * close the day in it. */
      var at = Math.max(open.sentAt, last.at);
      /* `ridAt` is this instant BEFORE the clamp, and the rid is keyed on it
       * rather than on `at`. Both of its inputs come from the database, so two
       * concurrent invocations always agree on it. `at` does not have that
       * property: when the clamp fires it IS the caller's clock, and two calls
       * either side of a minute boundary would key two different rids and write
       * the night twice. The row still lands at the clamped `at` — what the
       * clamp protects is the timestamp, not the identity of the write. */
      var ridAt = at;
      if (at > now) at = now;
      return { act: 'close', at: at, ridAt: ridAt, resolve: true,
               why: 'no answer within the hour, so the day ended when the check was sent' };
    }

    return { act: 'nothing', at: 0, resolve: false,
             why: 'the check is still inside its hour' };
  }

  if (!dayOpen) {
    return { act: 'nothing', at: 0, resolve: false, why: 'the day is already closed' };
  }
  if (!inCheckWindow(now)) {
    return { act: 'nothing', at: 0, resolve: false, why: 'not the time of night for it' };
  }
  return { act: 'check', at: now, resolve: false,
           why: 'the day is still open at bedtime' };
}

/** 'YYYY-MM-DD' for an instant, in Karachi. */
function localYmd(ms) {
  return new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DDTHH:MM' for an instant, in Karachi — the date above plus the
 *  clock, built from the same two helpers so it cannot disagree with either. */
function localStamp(ms) {
  var m = localMinuteOfDay(ms);
  var hh = Math.floor(m / 60);
  var mm = m % 60;
  return localYmd(ms) + 'T' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

/**
 * The two rows an auto-close writes, each with the rid that makes writing it
 * twice a no-op against the unique index on (user_id, rid).
 *
 * THE RID IS KEYED ON THE CLOSING INSTANT, NOT ON A DATE, and the date version
 * that stood here first is worth spelling out because it reads correct.
 *
 * It was `wrapup-<calendar date of the closing instant>-off`. A night that runs
 * past midnight closes on the NEXT calendar date, so a 2:30 AM close on the 9th
 * and the ordinary 11:30 PM close on the evening of the 9th produced the same
 * rid. The second insert hit the index, writeEvent read 23505 as success, and
 * that evening got no closing edge at all — its `worked` ran to the day ceiling
 * and its night became unmeasurable, which is the "a duration needs two events"
 * failure the whole data model is built to prevent.
 *
 * Shifting the date back five hours to get the LOGICAL night fixes that pair
 * and is still not enough: ignore the notification, get closed at 00:30, carry
 * on working, and the 1:00 AM check closes the same logical night a second time
 * — a different trigger for the identical silent loss.
 *
 * The instant is the identity of the logical write, which is what a rid is for.
 * Two calls deciding the same close agree on it exactly (it is `sentAt` or the
 * last row's stamp, both read from the database), so a doubled cron fire still
 * writes one row; two genuinely different closes differ, so both are written.
 * Minutes, not milliseconds: it is the one resolution at which the future-clock
 * clamp in shouldWrapUp() — the only part of `at` that comes from the caller's
 * own clock — still lands on the same value twice.
 */
function closingRows(at) {
  var stamp = localStamp(at);
  /* SLEEP FIRST, AND THE ORDER IS LOAD-BEARING. `off` is what makes the day
   * read as closed, so it must never be the row that survives alone: if `off`
   * landed and `sleep` then failed, the next run would see a closed day, resolve
   * the check and never write the night's other edge — a night with one edge is
   * unmeasurable, which is the failure the whole pairing rule exists to stop.
   * Written this way round, a failure leaves the day OPEN and the next run
   * retries the pair; the rid is deterministic, so whichever row already landed
   * is a harmless duplicate. */
  return [
    { type: 'sleep',
      text: 'Sleep (auto — no answer to the 11:30 pm check)',
      rid: 'wrapup-' + stamp + '-sleep' },
    { type: 'off',
      text: 'Day over (auto — no answer to the 11:30 pm check)',
      rid: 'wrapup-' + stamp + '-off' }
  ];
}

/**
 * Read what actually happened when those rows were written.
 *
 * @param rows  what closingRows() returned.
 * @param wrote one boolean per row, in order: false means Postgres refused it
 *              as a duplicate.
 *
 * This exists because a refused insert used to be invisible. writeEvent()
 * swallows the duplicate — correctly, a doubled cron fire IS a no-op — and
 * returned `false` to two callers that both threw it away, so a night with no
 * closing edge was reported as `{ok:true, act:'close'}`. Nothing was written and
 * nothing said so.
 *
 * `closed` IS NOT "nothing was refused", and reading it that way was itself a
 * bug. writeEvent() returns false only on 23505, and a 23505 against an
 * instant-keyed rid means THIS EXACT closing write already landed — `events`
 * has no delete policy, so a refused rid is positive evidence the row is in the
 * table. Under the old date-keyed rid a collision really did mean a lost night,
 * which is where the old reading came from; it stopped being true when the rid
 * started naming the instant. So the day is closed either way, and what the
 * caller actually wants to know is whether THIS call is the one that closed it:
 * that is `fresh`.
 */
function closeOutcome(rows, wrote) {
  var went = [];
  var refused = [];
  for (var i = 0; i < rows.length; i++) {
    if (wrote[i]) went.push(rows[i].rid);
    else refused.push(rows[i].rid);
  }
  return { closed: true, fresh: refused.length === 0,
           wrote: went, refused: refused };
}

/* ──────────────────────────────────────────────────────── end of the pure part */

const TZ = 'Asia/Karachi';

/** The same readable stamp every other row carries — "Tue 08 Sept, 11:30 pm".
 *  Stamped from the ROW'S OWN instant, never from the clock: a row backdated to
 *  11:30 PM whose human column says 00:31 is a column that lies. */
function humanLocal(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ
    });
  } catch (_e) {
    return new Date(ms).toISOString();
  }
}

/** "11:30 pm", for the notification's own words. */
function clockLocal(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ
    });
  } catch (_e) {
    return '';
  }
}

// ------------------------------------------------------------------ encoding

function b64urlToBytes(s: string): Uint8Array {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  parts.forEach((p) => { n += p.length; });
  const out = new Uint8Array(n);
  let at = 0;
  parts.forEach((p) => { out.set(p, at); at += p.length; });
  return out;
}

/** Constant time, because a shared secret compared with `===` leaks its own
 *  length and then its bytes to anyone patient enough to time the answers. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length > 0;
}

// --------------------------------------------------------------------- vapid

/* THE ONE SECRET IS THE PRIVATE KEY, AND THE PUBLIC HALF IS DERIVED FROM IT.
 *
 * PKCS#8 carries the public point inside it, so exporting the imported key as a
 * JWK hands back x and y. That is why scripts/make_vapid.js writes PKCS#8 rather
 * than the bare 32-byte scalar most VAPID tools print: a second secret holding
 * the public key could be pasted in wrong, and a mismatched pair fails as a
 * silent 403 from the push service — the exact shape of bug this stage cannot
 * afford, because nobody is watching at 11:30 PM. */
let vapidCache: { key: CryptoKey; pub: string } | null = null;

async function vapidKeys(): Promise<{ key: CryptoKey; pub: string }> {
  if (vapidCache) return vapidCache;

  const raw = (Deno.env.get('VAPID_PRIVATE_KEY') || '').trim();
  if (!raw) throw new Error('VAPID_PRIVATE_KEY is not set on this function');

  const key = await crypto.subtle.importKey(
    'pkcs8', b64urlToBytes(raw),
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = bytesToB64url(joinBytes([
    new Uint8Array([4]),
    b64urlToBytes(String(jwk.x || '')),
    b64urlToBytes(String(jwk.y || ''))
  ]));

  vapidCache = { key: key, pub: pub };
  return vapidCache;
}

/** The `Authorization: vapid t=…, k=…` header for one push endpoint. The token
 *  is scoped to the push service's own origin, so one signed for Google's
 *  service cannot be replayed at Mozilla's. */
async function vapidHeader(endpoint: string): Promise<string> {
  const { key, pub } = await vapidKeys();
  const aud = new URL(endpoint).origin;
  const sub = (Deno.env.get('VAPID_SUBJECT') || '').trim() ||
              'https://saad-jameel.github.io/probeing/';

  const enc = new TextEncoder();
  const head = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,   // must be under 24 hours
    sub: sub
  })));

  const signed = head + '.' + claims;
  /* Web Crypto's ECDSA signature is already the raw r||s pair JWS wants — no DER
   * unwrapping, which is the step Apps Script could not have done at all and the
   * reason this function exists in Deno. */
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signed)
  ));

  return 'vapid t=' + signed + '.' + bytesToB64url(sig) + ', k=' + pub;
}

// ---------------------------------------------------------------- encryption

/* Web Push payload encryption — RFC 8291 (aes128gcm), the whole of it.
 *
 * The push service never sees the message: it is encrypted to a key the browser
 * generated and only the browser holds. That is why the check's nonce can travel
 * this way at all.
 *
 * Every info string below is quoted from the RFC rather than remembered, because
 * one wrong byte here produces a push the browser silently drops — delivered,
 * undecryptable, no error anywhere. */
async function encryptPayload(p256dh: string, authSecret: string, plaintext: string) {
  const ua = b64urlToBytes(p256dh);          // the browser's public key, 65 bytes
  const auth = b64urlToBytes(authSecret);    // its 16-byte shared secret

  // A fresh sender keypair per message, as the RFC requires.
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  ) as CryptoKeyPair;
  const as = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, pair.privateKey, 256
  ));

  const enc = new TextEncoder();
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, k, bytes * 8
    ));
  };

  // RFC 8291 §3.4: the auth secret salts the first extraction, and the two
  // public keys are the context.
  const keyInfo = joinBytes([enc.encode('WebPush: info'), new Uint8Array([0]), ua, as]);
  const ikm = await hkdf(auth, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt']);
  /* 0x02 is the padding delimiter that marks the LAST record. One record is all
   * we ever send — the whole message is a few hundred bytes. */
  const body = joinBytes([enc.encode(plaintext), new Uint8Array([2])]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, body
  ));

  // RFC 8188 §2.1 header: salt | record size | key id length | key id | data.
  const rs = new Uint8Array([0, 0, 0x10, 0]);      // 4096
  return joinBytes([salt, rs, new Uint8Array([as.length]), as, sealed]);
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * Send one push. Returns the HTTP status, or 0 if the service was unreachable.
 *
 * A 404 or a 410 is the push service saying this subscription is dead — a
 * browser update, a long idle, a reinstall. It never happens loudly: the app
 * goes on working for three weeks and then the notifications simply stop. So a
 * dead endpoint is deleted here, and the app re-subscribes on every launch.
 */
async function sendPush(sub: Sub, payload: string, ttl: number): Promise<number> {
  let res: Response;
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, payload);
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await vapidHeader(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(ttl),
        'Urgency': 'high',
        'Topic': 'probeing-awake'
      },
      body: body
    });
  } catch (_e) {
    return 0;
  }
  return res.status;
}

// ---------------------------------------------------------------------- rows

const STATE_TYPES = ['sleep', 'wake', 'break', 'resume', 'off', 'work', 'voice'];

/** What a check id looks like, so a malformed one is refused here rather than
 *  by Postgres. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The service client. It bypasses row level security, so every write below
 *  must name `user_id` itself — the column's default is auth.uid(), which is
 *  NULL here, and the not-null constraint would refuse the row. The same trap
 *  docs/supabase_schema.sql already carries a paragraph about for `reports`. */
function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    { auth: { persistSession: false } }
  );
}

/**
 * Write one event row, treating a duplicate as the success it is.
 *
 * 23505 is the unique index on (user_id, rid). The rid here is deterministic —
 * `wrapup-2026-09-08T23:30-off` — so a cron that fires twice, or a retry after a
 * lost reply, lands on that index and changes nothing. Rows go in one at a time
 * rather than as a pair, because a single insert of two rows is refused whole
 * when either one collides.
 *
 * Returns TRUE for a row that went in and FALSE for one the index refused. The
 * caller must look: this reply is the only evidence that a close wrote nothing,
 * and for a while nobody read it. See closeOutcome().
 */
async function writeEvent(sb: ReturnType<typeof admin>, owner: string,
                          at: number, type: string, text: string, rid: string) {
  const res = await sb.from('events').insert({
    user_id: owner,
    at: new Date(at).toISOString(),
    local_time: humanLocal(at),
    tz: TZ,
    type: type,
    raw_text: text,
    project: '',
    detail: '',
    rid: rid
  });
  if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
  return !res.error;
}

// -------------------------------------------------------------------- serve

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let sent: Record<string, unknown> = {};
  try {
    sent = await req.json();
  } catch (_e) { /* an unparseable body is the cron's empty one */ }

  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) {
    return reply(403, { ok: false,
      error: 'this function is not pinned to an owner yet: set ALLOWED_USER_ID' });
  }

  /* ─── 1. answering the question ──────────────────────────────────────────
   * The one path with no login behind it, because the caller is a service
   * worker: the Supabase session lives in localStorage and a service worker
   * cannot read localStorage. The nonce is what stands in for it — 32 random
   * bytes that went out inside an encrypted payload, addressed to one device,
   * good for marking exactly one check answered and nothing else. */
  if (sent && sent.answer) {
    const ans = sent.answer as { id?: string; nonce?: string };
    const id = String(ans.id || '');
    const nonce = String(ans.nonce || '');

    /* The "Send me a test push" button's own Yes. It proves the whole round
     * trip — push out, notification tapped, service worker POSTs back — without
     * inventing a check row for a button press. It touches nothing. */
    if (id === 'test' && nonce === 'test') {
      return reply(200, { ok: true, test: true, answered: false });
    }
    /* Shape-checked before it reaches Postgres. An id that is not a uuid makes
     * the query itself fail, and this door answers strangers with a refusal, not
     * with a database error message. */
    if (!UUID.test(id) || !nonce) return reply(401, { ok: false, error: 'not a check of yours' });

    const sb = admin();
    const found = await sb.from('awake_checks')
      .select('id, answered_at, resolved').eq('id', id).eq('nonce', nonce).limit(1);
    if (found.error) return reply(500, { ok: false, error: found.error.message });

    const row = (found.data || [])[0];
    if (!row) return reply(401, { ok: false, error: 'not a check of yours' });

    /* ALREADY ANSWERED IS A SUCCESS, and the difference matters more than it
     * looks. A second tap on Yes — a double press, or a notification tapped
     * again in the morning — must not come back as a failure, because sw.js
     * turns a failure into an alarming notification about the day being closed.
     * Being asked twice is not the same as not being answered. */
    if (row.answered_at || row.resolved) {
      return reply(200, { ok: true, answered: Boolean(row.answered_at), already: true,
                          late: Boolean(row.resolved && !row.answered_at) });
    }

    const upd = await sb.from('awake_checks')
      .update({ answered_at: new Date().toISOString() }).eq('id', row.id).select('id');
    if (upd.error) return reply(500, { ok: false, error: upd.error.message });
    return reply(200, { ok: true, answered: true });
  }

  /* ─── 2. the test push ───────────────────────────────────────────────────
   * Gated exactly as `gemini` is, and for the reason its own comment gives:
   * Supabase's Verify JWT setting lets the public anon key straight through, so
   * the role claim is the check that separates a signed-in person from anyone
   * holding a key that ships inside the app. Copied rather than shared because
   * these are two hand-deployed functions with no module between them. */
  if (sent && sent.test) {
    const auth = req.headers.get('Authorization') || '';
    if (!/^Bearer\s+\S/i.test(auth)) return reply(401, { ok: false, error: 'sign in first' });

    const jwt = auth.replace(/^Bearer\s+/i, '').trim();
    let role = '';
    try {
      const b = jwt.split('.')[1] || '';
      const pad = '='.repeat((4 - (b.length % 4)) % 4);
      role = String(JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/') + pad)).role || '');
    } catch (_e) { /* an unreadable token is not a signed-in one */ }
    if (role !== 'authenticated') return reply(401, { ok: false, error: 'not a signed-in user' });

    const asUser = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_ANON_KEY') || '',
      { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }
    );
    let uid = '';
    try {
      const got = await asUser.auth.getUser();
      uid = (got && got.data && got.data.user && got.data.user.id) || '';
    } catch (_e) { /* unreachable auth server = not signed in, as far as this goes */ }
    if (!uid) return reply(401, { ok: false, error: 'sign in first' });
    if (uid !== owner) return reply(403, { ok: false, error: 'not your app' });

    const out = await pushAll(owner, JSON.stringify({
      kind: 'test',
      title: 'ProBeing',
      body: 'Test push. The 11:30 pm check will look like this, Yes button and all.',
      checkId: 'test',
      nonce: 'test',
      url: functionUrl(),
      key: Deno.env.get('SUPABASE_ANON_KEY') || ''
    }), 60);
    return reply(200, { ok: true, ...out });
  }

  /* ─── 3. the nightly run ─────────────────────────────────────────────────
   * The first thing this branch does, before a single row is read, is check the
   * shared secret. There is no user here to authenticate — pg_cron is not a
   * person — so this header is the whole gate, and anything without it is
   * refused before it can cost a database read or a push. */
  const secret = (Deno.env.get('CRON_SECRET') || '').trim();
  if (!secret) return reply(403, { ok: false, error: 'CRON_SECRET is not set on this function' });
  if (!sameSecret(req.headers.get('x-cron-secret') || '', secret)) {
    return reply(401, { ok: false, error: 'not the scheduler' });
  }

  /* `now` may be overridden ONLY here, inside the secret's protection. It is
   * what makes 11:30 PM testable from a curl at four in the afternoon, and the
   * reason the decision above takes it as an argument. */
  let now = Date.now();
  if (sent && sent.now) {
    const t = Date.parse(String(sent.now));
    if (isNaN(t)) return reply(400, { ok: false, error: 'now is not a date' });
    now = t;
  }

  const sb = admin();

  const lastRes = await sb.from('events')
    .select('at, type').eq('user_id', owner).in('type', STATE_TYPES)
    .order('at', { ascending: false }).limit(1);
  if (lastRes.error) return reply(500, { ok: false, error: lastRes.error.message });
  const lastRow = (lastRes.data || [])[0];
  const last = lastRow ? { type: String(lastRow.type), at: Date.parse(String(lastRow.at)) } : null;

  const openRes = await sb.from('awake_checks')
    .select('id, nonce, sent_at, answered_at').eq('user_id', owner).eq('resolved', false)
    .order('sent_at', { ascending: false }).limit(1);
  if (openRes.error) return reply(500, { ok: false, error: openRes.error.message });
  const openRow = (openRes.data || [])[0];
  const open = openRow
    ? { sentAt: Date.parse(String(openRow.sent_at)),
        answeredAt: openRow.answered_at ? Date.parse(String(openRow.answered_at)) : 0 }
    : null;

  const decided = shouldWrapUp(last, open, now);

  /* Typed, rather than the Record<string, unknown> the push half uses, because
   * `why` below reads two of these fields back out. */
  let closing: { closed?: boolean; fresh?: boolean; wrote?: string[];
                 refused?: string[]; failed?: string[] } = {};
  let why = decided.why;

  if (decided.act === 'close') {
    /* Two rows, the same pair pressing Sleep at night writes: `off` ends the
     * working day, `sleep` opens the night. Both stamped at the same instant —
     * their order between themselves is immaterial, since they are simultaneous
     * edges of two different state machines and no time passes between them.
     * closingRows() owns their rids, and its comment owns the reasoning. */
    const rows = closingRows(decided.ridAt || decided.at);
    const results: boolean[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      /* STOP AT THE FIRST FAILURE rather than pressing on. The rows are ordered
       * sleep-then-off precisely so that giving up half way leaves the day open
       * and retryable; writing `off` after `sleep` had failed would close a day
       * whose night can never now be measured. */
      if (failed.length) { results.push(false); continue; }
      try {
        results.push(await writeEvent(sb, owner, decided.at, row.type, row.text, row.rid));
      } catch (err) {
        /* This used to have no `try`, so the handler 500'd with the second row
         * never attempted — and the NEXT run saw a closed day, resolved the
         * check and moved on. The night lost its other edge behind a reassuring
         * message. Now the failure is reported and the check is left open. */
        results.push(false);
        failed.push(row.rid + ': ' + String((err && (err as Error).message) || err));
      }
    }

    closing = closeOutcome(rows, results);
    if (failed.length) {
      closing.failed = failed;
      closing.closed = false;
      why += ' — but the close did not finish (' + failed.join('; ') +
             '), so the day is still open and the check stays for the next run';
    } else if (!closing.fresh) {
      why += ' — ' + (closing.refused || []).join(' and ') +
             ' already existed, so this call wrote nothing: the day was already closed';
    }
  }

  let pushed: Record<string, unknown> = {};
  let checkId = '';
  if (decided.act === 'check') {
    const nonce = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    const made = await sb.from('awake_checks').insert({
      user_id: owner,
      sent_at: new Date(decided.at).toISOString(),
      local_time: humanLocal(decided.at),
      nonce: nonce
    }).select('id');
    if (made.error) return reply(500, { ok: false, error: made.error.message });
    const madeRow = (made.data || [])[0];
    if (!madeRow) return reply(500, { ok: false, error: 'the check row did not come back' });
    checkId = String(madeRow.id);

    pushed = await pushAll(owner, JSON.stringify({
      kind: 'awake',
      title: 'ProBeing',
      body: 'Still awake? Tap Yes. With no answer your day is recorded as ending at ' +
            clockLocal(decided.at) + '.',
      checkId: checkId,
      nonce: nonce,
      url: functionUrl(),
      key: Deno.env.get('SUPABASE_ANON_KEY') || ''
    }), 3600);

    /* NOTHING WAS DELIVERED, SO NOTHING WAS ASKED. Leaving the row would close
     * the day an hour later on the strength of a question that never arrived —
     * silence from a phone that was never rung is not an answer. Dropping it
     * means the next run, ten minutes later, tries again, and a night with no
     * working subscription ends with the day simply left open. */
    if (!pushed.sent) {
      await sb.from('awake_checks').delete().eq('id', checkId);
      checkId = '';
    }
  }

  /* A check is only finished with once the work it was waiting on actually
   * landed. Resolving it after a half-written close is what turned a transient
   * database error into a permanently unmeasurable night: the check disappeared,
   * so no later run ever tried again. */
  const closeUnfinished = decided.act === 'close' && closing.closed === false;
  if (decided.resolve && openRow && !closeUnfinished) {
    await sb.from('awake_checks').update({ resolved: true }).eq('id', openRow.id);
  }

  return reply(200, {
    ok: true, act: decided.act, why: why,
    at: decided.at ? new Date(decided.at).toISOString() : null,
    local_time: decided.at ? humanLocal(decided.at) : null,
    check_id: checkId || null,
    ...closing,
    ...pushed
  });
});

/** This function's own address, so the service worker knows where to send the
 *  answer without holding any configuration of its own. */
function functionUrl(): string {
  return (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '') + '/functions/v1/wrapup';
}

/** Push to every device this account has registered, and clear out the dead
 *  ones. Returns `{sent, failed, dropped}` for the reply. */
async function pushAll(owner: string, payload: string, ttl: number) {
  const sb = admin();
  const subs = await sb.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', owner);
  if (subs.error) return { sent: 0, failed: 0, dropped: 0, error: subs.error.message };

  let ok = 0;
  let bad = 0;
  let gone = 0;
  for (const sub of (subs.data || []) as Sub[]) {
    const status = await sendPush(sub, payload, ttl);
    if (status >= 200 && status < 300) { ok += 1; continue; }
    if (status === 404 || status === 410) {
      await sb.from('push_subscriptions').delete().eq('id', sub.id);
      gone += 1;
      continue;
    }
    bad += 1;
  }
  return { sent: ok, failed: bad, dropped: gone };
}
