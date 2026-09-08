/* Make the three secrets Stage 7a needs, and put them OUTSIDE this repo.
 *
 *   source ~/.nvm/nvm.sh && nvm use
 *   node scripts/make_vapid.js
 *
 * Writes ~/.probeing/vapid_public.txt, ~/.probeing/vapid_private.txt and
 * ~/.probeing/cron_secret.txt, all mode 0600. Nothing is printed except the
 * PUBLIC key, which is public by design — it ships inside app.js, exactly as
 * the Supabase anon key does.
 *
 * No npm package. Node's own crypto generates P-256, which is the only curve
 * Web Push allows; pulling in `web-push` for one keypair would add a dependency
 * to a repo that has none.
 *
 * IT REFUSES TO OVERWRITE, and that is the important line in this file. The
 * VAPID keypair is the identity every existing push subscription was signed to:
 * regenerate it and every subscription on every device is silently dead — the
 * push service answers 403 and nothing in the app looks broken. Deleting the
 * files by hand is a deliberate act; doing it by re-running a script is not.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var HOME = path.join(os.homedir(), '.probeing');

/** base64url, no padding — the one encoding Web Push uses everywhere. */
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The three files this script owns. Named in one place because they are
 *  checked as a set. */
var SECRETS = ['vapid_public.txt', 'vapid_private.txt', 'cron_secret.txt'];

/* ALL THREE ARE CHECKED BEFORE ANY OF THEM IS WRITTEN, and that ordering is the
 * point. Checking each file as it was written meant a HALF-full ~/.probeing got
 * two new files and then a thrown error — so a leftover vapid_private.txt from
 * an earlier run could end up beside a vapid_public.txt from this one. That pair
 * does not fail here, where it would be obvious. It fails weeks later as a 403
 * from the push service, with nothing in the app looking broken, which is the
 * worst state this particular pair can be in. */
function refuseExisting() {
  var already = SECRETS.filter(function (name) {
    return fs.existsSync(path.join(HOME, name));
  });
  if (already.length) {
    throw new Error('Nothing was written. ' + HOME + ' already holds ' + already.join(', ') +
                    '. Delete them by hand — all of them, not some — if you really mean to ' +
                    'replace them, and see the warning at the top of this file first.');
  }
}

function writeSecret(name, text) {
  var file = path.join(HOME, name);
  // Redundant after refuseExisting(), and kept as the last line of defence:
  // this function must never be the thing that overwrites a live key.
  if (fs.existsSync(file)) {
    throw new Error(file + ' already exists. Delete it by hand if you really mean to ' +
                    'replace it — see the warning at the top of this file.');
  }
  fs.writeFileSync(file, text + '\n', { mode: 0o600 });
  return file;
}

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
refuseExisting();

var pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/* The public key travels as the raw uncompressed point: 0x04 || x || y, 65
 * bytes. That is what `pushManager.subscribe` wants as applicationServerKey and
 * what the push service wants in the `k=` half of the Authorization header. */
var jwk = pair.publicKey.export({ format: 'jwk' });
var pub = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url')
]);

/* The private key travels as PKCS#8, not as the bare 32-byte scalar that most
 * VAPID tools print. Deliberate: PKCS#8 carries the public half with it, so the
 * Edge Function can import ONE secret and derive the `k=` value from it rather
 * than trusting a second secret to have been pasted in matching. One value
 * cannot drift from itself. */
var priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' });

var files = [];
files.push(writeSecret('vapid_public.txt', b64url(pub)));
files.push(writeSecret('vapid_private.txt', b64url(priv)));

/* The shared secret pg_cron sends in `x-cron-secret`. 32 random bytes: this is
 * the only thing standing between the internet and a function that can write
 * rows as you, so it is not a passphrase anybody types. */
files.push(writeSecret('cron_secret.txt', b64url(crypto.randomBytes(32))));

console.log('Wrote:');
files.forEach(function (f) { console.log('  ' + f); });
console.log('\nPUBLIC key (safe to paste anywhere, and already in app.js):\n');
console.log('  ' + b64url(pub) + '\n');
console.log('The private key and the cron secret were NOT printed. Read them with');
console.log('`cat` when the Supabase dashboard asks for them.');
