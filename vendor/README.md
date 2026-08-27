# vendor/

Third-party code, committed rather than fetched from a CDN.

**Why committed:** this project has no build step, and a CDN is a third party
whose outage takes the app down. A file in the repo is served by GitHub Pages
alongside everything else and cached by the service worker like the rest of the
shell.

## supabase.js

The official `@supabase/supabase-js` v2 UMD bundle, used for three things the
app cannot reasonably hand-roll: auth token handling, the PostgREST client, and
the Realtime WebSocket protocol (Phoenix channels, heartbeats, reconnection).

Verified before committing:

| check | result |
|---|---|
| `sha256` | `f8ce7fab799af1916019cbd0b485b39bb80dbdbc6dc062909a751c9e5198e04c` |
| byte-identical from a second independent mirror (jsdelivr *and* unpkg) | yes |
| hosts referenced in the source | `localhost`, `developer.mozilla.org`, `github.com` — all in comments/errors |
| `eval(` / `document.cookie` / `innerHTML` | 0 occurrences each |

To update it, re-download from both mirrors, confirm the hashes match each
other, re-run those checks, and record the new hash here.

```bash
curl -sL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js -o vendor/supabase.js
curl -sL https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js -o /tmp/check.js
sha256sum vendor/supabase.js /tmp/check.js   # the two must match
```
