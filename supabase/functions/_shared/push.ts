// Web Push for the Edge Functions: VAPID (ES256) signing and RFC 8291 payload
// encryption, then one send per registered device.
//
// Copied from wrapup/index.ts, which still keeps its own copy: wrapup is live,
// and moving it onto this file is a redeploy of its own (Stage 17's refactor).
// The one change is that the Topic and Urgency headers are the caller's.
//
// Secrets: VAPID_PRIVATE_KEY (base64url PKCS#8), VAPID_SUBJECT optional.

export type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

/** `topic`: a newer push with the same topic replaces one the push service is
 *  still holding for an offline device. At most 32 base64url characters. */
export type PushOptions = { ttl: number; topic: string; urgency?: string };

// ------------------------------------------------------------------ encoding

export function b64urlToBytes(s: string): Uint8Array {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
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

// --------------------------------------------------------------------- vapid

// The public half is derived from the PKCS#8 private key, so there is one secret, not a pair to mismatch.
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

/** `Authorization: vapid t=…, k=…` for one endpoint, scoped to its push service's origin. */
export async function vapidHeader(endpoint: string): Promise<string> {
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
  // Web Crypto's ECDSA signature is already the raw r||s that JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signed)
  ));

  return 'vapid t=' + signed + '.' + bytesToB64url(sig) + ', k=' + pub;
}

// ---------------------------------------------------------------- encryption

/* RFC 8291 (aes128gcm). Info strings are the RFC's: one wrong byte and the
 * browser drops the push silently. */
export async function encryptPayload(p256dh: string, authSecret: string, plaintext: string) {
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

  // RFC 8291 §3.4: the auth secret salts the first extraction; the two public keys are the context.
  const keyInfo = joinBytes([enc.encode('WebPush: info'), new Uint8Array([0]), ua, as]);
  const ikm = await hkdf(auth, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (and only) record.
  const body = joinBytes([enc.encode(plaintext), new Uint8Array([2])]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, body
  ));

  // RFC 8188 §2.1 header: salt | record size | key id length | key id | data.
  const rs = new Uint8Array([0, 0, 0x10, 0]);      // 4096
  return joinBytes([salt, rs, new Uint8Array([as.length]), as, sealed]);
}

// ---------------------------------------------------------------------- send

/** One push. The HTTP status, or 0 when the push service could not be reached. */
export async function sendPush(sub: Sub, payload: string, opts: PushOptions): Promise<number> {
  let res: Response;
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, payload);
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await vapidHeader(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(Math.max(0, Math.floor(opts.ttl))),
        'Urgency': opts.urgency || 'high',
        'Topic': opts.topic
      },
      body: body
    });
  } catch (_e) {
    return 0;
  }
  return res.status;
}

/** Push to every device the owner registered; a 404/410 endpoint is dead and
 *  deleted (the app re-subscribes at launch). `sb` is a service-role client. */
// deno-lint-ignore no-explicit-any
export async function pushAll(sb: any, owner: string, payload: string, opts: PushOptions,
                              skipEndpoint = '') {
  const subs = await sb.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', owner);
  if (subs.error) return { sent: 0, failed: 0, dropped: 0, error: String(subs.error.message) };

  let ok = 0;
  let bad = 0;
  let gone = 0;
  for (const sub of (subs.data || []) as Sub[]) {
    if (skipEndpoint && sub.endpoint === skipEndpoint) continue;
    const status = await sendPush(sub, payload, opts);
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
