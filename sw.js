/* ProBeing service worker — app shell only.
 *
 * Deliberately does NOT cache API traffic: the Sheet is the source of truth and
 * a cached "today" would silently show you stale logs. Offline *logging* is
 * Stage 7c and will use a localStorage queue, not this cache.
 *
 * SAVED REPORTS ARE API TRAFFIC TOO, and the same rule covers them: they are
 * read from Supabase on every visit to the Review tab. Nothing below has to be
 * changed for that to hold — Supabase is a different origin, and the guard in
 * the fetch handler already lets every cross-origin request straight through —
 * but it is worth saying, because "it is only a report, it barely changes" is
 * exactly the argument that would put a stale one on screen.
 *
 * Stage 7a added the two handlers at the bottom: `push` and `notificationclick`.
 * They are the only part of ProBeing that runs while the app is closed, which is
 * the whole point — at 11:30 PM the phone is on a bedside table with the screen
 * off. Neither of them touches the cache above.
 */

var CACHE = 'probeing-shell-v3';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'vendor/supabase.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  // Only ever serve our own same-origin GETs from cache. Backend POSTs to
  // script.google.com must always hit the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Network-first so a deploy shows up immediately; cache is the offline net.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});

// ------------------------------------------------------- the 11:30 PM check
/* THE ONLY CODE IN PROBEING THAT RUNS WITH THE APP CLOSED.
 *
 * A push arrives from the `wrapup` Edge Function, encrypted end to end, and this
 * turns it into a notification with a Yes button. Tapping Yes posts an answer
 * straight back — no window is opened, nothing is unlocked, and the whole thing
 * is over in the second it takes to reach out from under a duvet.
 *
 * IT CANNOT USE THE SIGN-IN, and this is the constraint that shapes everything
 * below. The Supabase session lives in localStorage, and a service worker has no
 * localStorage — the storage a worker can reach is IndexedDB, which the session
 * is not in. So the credential is a NONCE that arrived inside the encrypted
 * payload: 32 random bytes, addressed to this device, good for marking exactly
 * one check answered. The address to send it to and the app's public anon key
 * ride along in the same payload, so this file holds no configuration of its own
 * and cannot drift from what is in Settings.
 */

/** Everything the notification needs, and nothing it does not. Kept small
 *  deliberately: a push payload has about four kilobytes and the anon key alone
 *  is two hundred characters. */
function pushData(event) {
  try {
    return (event.data && event.data.json()) || {};
  } catch (e) {
    return {};                       // an unreadable payload still gets a shout
  }
}

self.addEventListener('push', function (event) {
  var data = pushData(event);

  /* A notification MUST be shown for every push. Chrome allowed the subscription
   * on the promise that each one is visible (userVisibleOnly), and a push that
   * shows nothing gets you "This site has been updated in the background" today
   * and the permission revoked eventually. So the fallbacks below are real
   * behaviour, not politeness. */
  var title = String(data.title || 'ProBeing');
  var body = String(data.body || 'Are you still awake?');

  var options = {
    body: body,
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-32.png',
    // One question at a time: a second check REPLACES the first in the shade
    // rather than stacking two identical rows nobody reads.
    tag: 'probeing-awake',
    renotify: true,
    // It has to survive being ignored for an hour — that hour is the whole
    // mechanism. On a desktop Chrome this is what stops the toast fading out
    // on its own after a few seconds. It does NOTHING on Chrome for Android,
    // which ignores the flag; there the notification sits in the shade until
    // it is dealt with anyway, so the behaviour is the same for a different
    // reason. Do not delete it because "the phone works without it".
    requireInteraction: true,
    data: {
      checkId: data.checkId || '',
      nonce: data.nonce || '',
      url: data.url || '',
      key: data.key || ''
    }
  };

  // The button only exists when there is something to answer with. An action
  // that posts nowhere is worse than no action.
  if (data.checkId && data.nonce) {
    options.actions = [{ action: 'yes', title: 'Yes' }];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

/** Post the answer. Returns the parsed reply, or null if it could not be sent. */
function answerCheck(data) {
  if (!data || !data.url || !data.checkId || !data.nonce) return Promise.resolve(null);

  return fetch(data.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      /* The public anon key, as it arrived in the payload. Supabase's platform
       * gate wants a project token on every function call; it is not what
       * protects this one — the nonce in the body is. */
      'Authorization': 'Bearer ' + data.key,
      'apikey': data.key
    },
    body: JSON.stringify({ answer: { id: data.checkId, nonce: data.nonce } })
  }).then(function (res) {
    if (!res.ok) return null;
    return res.json().catch(function () { return null; });
  }).catch(function () {
    return null;                     // no signal, or the function is down
  });
}

self.addEventListener('notificationclick', function (event) {
  var data = (event.notification && event.notification.data) || {};
  var pressedYes = event.action === 'yes';
  event.notification.close();

  if (!pressedYes) {
    // The body of the notification was tapped, not the button: open the app and
    // let him answer, or do whatever he actually opened it for.
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          if ('focus' in list[i]) return list[i].focus();
        }
        return self.clients.openWindow('./');
      }));
    return;
  }

  /* A YES THAT SILENTLY FAILED IS THE WORST OUTCOME IN THIS STAGE. He answered,
   * the answer went nowhere, and an hour later his day is recorded as having
   * ended at 11:30 PM — a wrong figure produced by doing the right thing. So a
   * failure has to say so, loudly enough to be seen in the morning. */
  event.waitUntil(answerCheck(data).then(function (reply) {
    if (reply && reply.ok) return;
    return self.registration.showNotification('ProBeing', {
      body: 'Could not record your answer — open ProBeing so tonight is not ' +
            'logged as ending at bedtime.',
      icon: 'icons/icon-192.png',
      badge: 'icons/favicon-32.png',
      tag: 'probeing-awake-failed',
      requireInteraction: true
    });
  }));
});
