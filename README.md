# ProBeing

A basic, free activity keeper for mobile + laptop, always in sync.

Two mandatory buttons (**M** and **Prayer**), a tracker input for everything else, and weekly
reviews. Free end to end: a PWA on GitHub Pages, a Google Apps Script backend, and a Google
Sheet as the database.

## Setup

1. **Sheet + backend** — create a Google Sheet, open `Extensions → Apps Script`, paste
   `backend/Code.gs`, add a `TOKEN` script property, run `setupSheet()`, then deploy as a Web
   App (*Execute as: Me*, *Access: Anyone*).
2. **App** — open the GitHub Pages URL in Chrome, tap the gear, paste the Web App URL and token,
   press **Test**, then **Save**.
3. **Install** — Chrome's install prompt on the laptop; `⋮ → Add to Home screen` on Android.

Repeat step 2 once per device. Nothing else to install.

## Development

```bash
source ~/.nvm/nvm.sh && nvm use   # Node 22
npm run serve                     # http://localhost:8080
```

See `CLAUDE.md` for architecture and the rules that matter, and
`docs/ProBeing_Execution_Plan.md` for the staged roadmap.
