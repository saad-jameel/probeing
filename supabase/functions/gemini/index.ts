// ProBeing — the `gemini` Edge Function.
//
// Why this exists at all: the Gemini API key must never reach a browser. This
// repo is public and the app ships as plain files, so anything app.js can read,
// the world can read. The key lives only as a Supabase function secret, and the
// browser asks this function to do the talking on its behalf.
//
// Deliberately tiny — one prompt in, one string out, and optionally a schema that
// says what shape that string must be. No date ranges, no database reads, no
// review logic. Stage 5 replaces it with the real report generator, and keeping it
// this small is what makes throwing it away cost nothing.
//
// Deployed by hand; the repo stays the source of truth:
//   npx supabase secrets set GEMINI_API_KEY=... --project-ref <ref>
//   npx supabase functions deploy gemini --project-ref <ref>
//
// THE REPO CANNOT PROVE WHAT IS RUNNING HERE, and it has already been wrong
// once: the model name in this file and the one in the deployed copy drifted
// apart, which is why MODEL is read from an env var below rather than being
// edited in place. Every functional change to this file — the structured-output
// block below is one — is dead in the repo until somebody pastes the file into
// the dashboard and presses Deploy. A comment-only change is safe to leave.
//
// Leave the project's "Verify JWT" setting ON (the default). It is a free extra
// layer, but it is NOT the check that matters — see steps 2 and 4 below for why.
//
// REQUIRED, or the function refuses everyone:
//   npx supabase secrets set ALLOWED_USER_ID=<the owner's user id> --project-ref <ref>

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/* Google retires model names out from under you. `gemini-2.5-flash` was the
 * default here for one day before it began answering "no longer available to
 * new users", naming `gemini-3.6-flash` as its replacement — which is where
 * this value came from, quoted from the API's own refusal rather than guessed.
 *
 * That is exactly why the name is an env var first and a literal second: the
 * next time this happens it is a secret to change in the dashboard, not a
 * function to redeploy. Set GEMINI_MODEL to override without touching code. */
const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash';

// A cross-origin POST carrying an Authorization header is always preflighted, so
// this has to answer OPTIONS. (The Edge runtime can; the Apps Script backend
// famously could not, which is why that half of the app posts as text/plain.)
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

/* Nothing that leaves this function may carry the key. Google echoes the key back
 * inside some of its own error payloads, so scrub anything key-shaped out of every
 * message rather than trusting the upstream to be careful on our behalf. */
function scrub(text: unknown): string {
  return String(text ?? '').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
}

/** The claims half of a JWT, unverified. getUser() below does the verifying; this
 *  exists only to read `role`, which is the check that actually matters. */
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

  // 1. The caller's own credential, verbatim — never a key of ours.
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S/i.test(auth)) {
    return reply(401, { ok: false, error: 'sign in first' });
  }
  const jwt = auth.replace(/^Bearer\s+/i, '').trim();

  /* 2. The load-bearing check, and the one that would be quietly omitted.
   *    Supabase's own "Verify JWT" gate is NOT enough here: the anon key that
   *    ships inside the public app is itself a structurally valid project JWT and
   *    sails straight through it. What separates a signed-in person from anyone
   *    holding that public key is the role claim — `authenticated` vs `anon`. */
  if (claims(jwt).role !== 'authenticated') {
    return reply(401, { ok: false, error: 'not a signed-in user' });
  }

  /* 3. And the signature has to be real, which only Supabase can say. Wrapped,
   *    because a network blip on the way to the auth server must still come back
   *    as the JSON shape the app expects, not as the runtime's own 500 page. */
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_ANON_KEY') || '',
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }
  );
  let user: { id: string } | null = null;
  try {
    const { data, error } = await sb.auth.getUser();
    if (!error && data && data.user) user = data.user;
  } catch (_e) { /* unreachable auth server = not signed in, as far as this goes */ }
  if (!user) return reply(401, { ok: false, error: 'sign in first' });

  /* 4. One person uses this app, so pin it to them — and pin it CLOSED.
   *
   *    Being signed in is a weaker statement than it sounds, and this check is
   *    what makes up the difference. Sign-ups are disabled on the project as of
   *    30 Aug 2026, so today only Saad can reach check 4 at all — which is
   *    exactly why the line is easy to mistake for dead weight and delete.
   *
   *    It is not. Sign-ups are one dashboard toggle, and the day they are turned
   *    back on — to add a second device, to try email login, by accident —
   *    anyone on the internet can mint a `role: authenticated` token and sail
   *    through checks 1 to 3. Row level security would still keep them out of
   *    the data; nothing but this line would keep them off the Gemini bill.
   *    The check has to outlive the setting that currently makes it redundant.
   *
   *    So an unset ALLOWED_USER_ID refuses everyone rather than admitting
   *    everyone. The id stays in an env var and out of the source, where it would
   *    rot unnoticed; but the safe state has to be the default state, and adding
   *    a second person must be an act of setting something, never of forgetting
   *    to. */
  const owner = (Deno.env.get('ALLOWED_USER_ID') || '').trim();
  if (!owner) {
    return reply(403, { ok: false,
      error: 'this function is not pinned to an owner yet: set the ALLOWED_USER_ID ' +
             'secret to the user id allowed to use it' });
  }
  if (user.id !== owner) return reply(403, { ok: false, error: 'not your app' });

  const key = Deno.env.get('GEMINI_API_KEY') || '';
  if (!key) return reply(500, { ok: false, error: 'GEMINI_API_KEY is not set on this function' });

  /* `prompt` alone is the original contract and still works untouched — that is
   * what keeps Settings -> Test Gemini passing after this change.
   *
   * `json` and `schema` are the addition. Asking a model in prose to "reply with
   * only JSON" gets you JSON wrapped in ``` fences some fraction of the time, and
   * every one of those is a row the app quietly fails to label. Structured output
   * makes that the API's problem instead of ours.
   *
   * The schema arrives in the request rather than living here as a constant,
   * because the shape is the CALLER's business: Stage 4 wants {project, detail}
   * and Stage 5 will want something else entirely. Accepting it costs nothing —
   * only the one pinned owner can reach this line at all. */
  let prompt = '';
  let wantsJson = false;
  let schema: unknown = null;
  try {
    const sent = await req.json();
    prompt = String((sent && sent.prompt) || '').trim();
    wantsJson = Boolean(sent && sent.json);
    if (sent && sent.schema && typeof sent.schema === 'object') schema = sent.schema;
  } catch (_e) { /* an unparseable body is just a missing prompt */ }
  if (!prompt) return reply(400, { ok: false, error: 'prompt is required' });

  const ask: Record<string, unknown> = { contents: [{ parts: [{ text: prompt }] }] };
  if (wantsJson || schema) {
    const gen: Record<string, unknown> = { responseMimeType: 'application/json' };
    if (schema) gen.responseSchema = schema;
    ask.generationConfig = gen;
  }

  // The key travels in a header, not the query string, so it cannot end up in a
  // redirect, a referrer, or somebody's request log. Wrapped for the same reason
  // as the auth call above: every exit from this function is `{ok: ...}` JSON,
  // including the ones where Google is simply unreachable.
  let res: Response;
  try {
    res = await fetch(GEMINI_URL + MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(ask)
    });
  } catch (e) {
    return reply(502, { ok: false, error: 'could not reach gemini: ' + scrub(e) });
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const why = scrub((body && body.error && body.error.message) || res.status);
    return reply(502, { ok: false, error: 'gemini (' + MODEL + ') refused: ' + why });
  }

  const parts = (body && body.candidates && body.candidates[0] &&
                 body.candidates[0].content && body.candidates[0].content.parts) || [];
  const text = parts.map((p: { text?: string }) => p.text || '').join('').trim();
  if (!text) return reply(502, { ok: false, error: 'gemini answered with nothing' });

  return reply(200, { ok: true, text: scrub(text), model: MODEL });
});
