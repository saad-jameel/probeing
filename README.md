# ProBeing

A basic, free activity keeper for mobile + laptop, always in sync.

Two mandatory buttons (**M** and **Prayer**), a tracker input for everything else, and weekly
reviews. Free end to end: a PWA on GitHub Pages with **Supabase** behind it — Postgres for the
rows, GitHub sign-in and row level security so they are yours alone, Realtime so the phone and
the laptop correct each other without a refresh, and Edge Functions for the two jobs that hold
a key (Gemini, and the 11:30 pm push). The original Apps Script + Google Sheet backend is
frozen, and is still selectable in Settings as a fallback.

## Setup

1. **Database** — create a Supabase project and run `docs/supabase_schema.sql` in its SQL
   editor. It is safe to run more than once and never rewrites existing rows.
2. **App** — open the GitHub Pages URL in Chrome and sign in with GitHub. The project address
   and its public anon key already ship in the app; Settings is where you would change them,
   and where the per-device options live.
3. **Install** — Chrome's install prompt on the laptop; `⋮ → Add to Home screen` on Android.

Repeat step 2 once per device. Nothing else to install.

## Development

```bash
source ~/.nvm/nvm.sh && nvm use   # Node 22
npm run serve                     # http://localhost:8080
```

See `CLAUDE.md` for architecture and the rules that matter, and
`docs/ProBeing_Execution_Plan.md` for the staged roadmap.
