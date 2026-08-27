#!/usr/bin/env bash
# ProBeing secret gate.
#
# The repo must be PUBLIC for GitHub Pages to be free, so anything committed is
# world-readable forever. This runs before every push. Exit 0 = safe to push.
#
#   bash scripts/secret_scan.sh          # working tree + full history
#   bash scripts/secret_scan.sh --quick  # working tree only (faster)

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 2

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAILURES=0
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }

echo "ProBeing secret scan"
echo "===================="

# --- 1. the real token must never appear in a tracked file -------------------
TOKEN_FILE="$HOME/.probeing/token.txt"
if [ -r "$TOKEN_FILE" ]; then
  TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
  if [ ${#TOKEN} -ge 12 ]; then
    HITS=$(git grep -l --fixed-strings -- "$TOKEN" -- ':!scripts/secret_scan.sh' 2>/dev/null)
    if [ -n "$HITS" ]; then
      fail "live TOKEN found in tracked files:"
      printf '        %s\n' $HITS
    else
      pass "live TOKEN absent from tracked files"
    fi
  else
    pass "token file too short to scan meaningfully (skipped)"
  fi
else
  pass "no local token file to compare against (skipped)"
fi

# --- 2. no deployed Apps Script endpoint in tracked files --------------------
# Placeholders in docs are fine; a real deployment id is not.
URL_HITS=$(git grep -nE 'macros/s/[A-Za-z0-9_-]{30,}' -- . 2>/dev/null)
if [ -n "$URL_HITS" ]; then
  fail "real Apps Script /exec URL committed:"
  printf '        %s\n' "$URL_HITS"
else
  pass "no real Apps Script deployment URL committed"
fi

# --- 3. credential files must not be tracked --------------------------------
for f in .clasp.json .clasprc.json backend/.clasp.json; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    fail "$f is tracked by git — it holds credentials"
  fi
done
# .env.example / .env.sample are templates and SHOULD be tracked; a real .env
# never should. Match .env and .env.<machine>, but not the templates.
ENV_TRACKED=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.(example|sample|template)$' || true)
[ -n "$ENV_TRACKED" ] && fail "real .env file tracked: $ENV_TRACKED"
pass "credential files (.clasp.json/.clasprc.json/.env) not tracked"

# A template is only safe while it still holds placeholders.
for tpl in $(git ls-files | grep -E '\.(example|sample|template)$' || true); do
  if [ -r "$TOKEN_FILE" ] && [ ${#TOKEN} -ge 12 ] && grep -qF -- "$TOKEN" "$tpl" 2>/dev/null; then
    fail "$tpl contains the REAL token — it must hold placeholders only"
  fi
  if grep -qE 'macros/s/[A-Za-z0-9_-]{30,}' "$tpl" 2>/dev/null; then
    fail "$tpl contains a REAL Apps Script URL — it must hold placeholders only"
  fi
done

# --- 4. generic high-entropy credential shapes ------------------------------
# Google API keys (AIza...) and OAuth client secrets have recognisable prefixes.
KEY_HITS=$(git grep -nE 'AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{28}' -- ':!scripts/secret_scan.sh' 2>/dev/null)
if [ -n "$KEY_HITS" ]; then
  fail "Google API key / OAuth secret committed:"
  printf '        %s\n' "$KEY_HITS"
else
  pass "no Google API key or OAuth secret in tracked files"
fi

# --- 5. Supabase project details -------------------------------------------------
# The anon key is publishable BY DESIGN — row level security is what protects
# the data. But the project ref identifies whose database it is, and the
# convention here is the same as everywhere else: connection details live in
# Settings on the device, never in a file the whole internet can read.
if [ -f "$HOME/.probeing/supabase_url.txt" ]; then
  REF=$(sed -E 's#https?://([^.]+)\..*#\1#' "$HOME/.probeing/supabase_url.txt" | tr -d '\n')
  if [ -n "$REF" ] && git grep -qI --cached -- "$REF" 2>/dev/null; then
    fail "Supabase project ref present in a tracked file"
    git grep -nI --cached -- "$REF" | head -5
  else
    pass "no Supabase project ref in tracked files"
  fi
fi

# --- 6. history, not just the working tree ----------------------------------
# A secret removed in a later commit is still public in an earlier one.
if [ "$QUICK" -eq 0 ] && git rev-parse HEAD >/dev/null 2>&1; then
  HIST_BAD=0
  if [ -r "$TOKEN_FILE" ] && [ ${#TOKEN} -ge 12 ]; then
    if git log -S"$TOKEN" --oneline --all 2>/dev/null | grep -q .; then
      fail "live TOKEN appears somewhere in committed history"
      HIST_BAD=1
    fi
  fi
  if git log -S'macros/s/' --oneline --all -- . 2>/dev/null | grep -q .; then
    HIST_URL=$(git log -S'macros/s/' --oneline --all -- . 2>/dev/null | head -3)
    # Only fail on a real-length id, not the placeholder in docs.
    if git grep -qE 'macros/s/[A-Za-z0-9_-]{30,}' $(git rev-list --all) -- . 2>/dev/null; then
      fail "real Apps Script URL appears in committed history:"
      printf '        %s\n' "$HIST_URL"
      HIST_BAD=1
    fi
  fi
  [ "$HIST_BAD" -eq 0 ] && pass "committed history clean"
else
  pass "history scan skipped (--quick or no commits yet)"
fi

echo "===================="
if [ "$FAILURES" -gt 0 ]; then
  printf '\033[31mBLOCKED: %d problem(s). Do not push.\033[0m\n' "$FAILURES"
  echo "Remove the secret, and if it was already committed, rewrite history or rotate it."
  exit 1
fi
printf '\033[32mCLEAR: safe to push.\033[0m\n'
exit 0
