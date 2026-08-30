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

# A NOTE ON `git log … | grep -q`, WHICH THIS FILE NO LONGER USES.
#
# `grep -q` exits the moment it matches. That closes the pipe, `git log` dies of
# SIGPIPE (141), and `set -o pipefail` on line 10 promotes 141 to the pipeline's
# status — which `if` then reads as "no match". Measured: 15 times out of 20 the
# check silently did not fire. A gate that lies three times in four is worse than
# no gate, because it is trusted.
#
# So: capture first, then test for emptiness. Never put a short-circuiting
# consumer in the condition itself.

FAILURES=0
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }

# Search tracked files as they are ON DISK *and* as they are STAGED, and print
# whatever matches. `git grep` alone sees only the working tree and `git grep
# --cached` only the index, and a gate that sees one of the two can be walked
# straight past: a key pasted into a tracked file but not yet `git add`ed is one
# keystroke from a commit, and a key staged and then reverted on disk is already
# sitting in the index. Callers test for empty output rather than exit status,
# because two greps have two of those.
scan() { { git grep "$@" 2>/dev/null; git grep --cached "$@" 2>/dev/null; } | sort -u; }

echo "ProBeing secret scan"
echo "===================="

# --- 1. the real token must never appear in a tracked file -------------------
TOKEN_FILE="$HOME/.probeing/token.txt"
if [ -r "$TOKEN_FILE" ]; then
  TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
  if [ ${#TOKEN} -ge 12 ]; then
    HITS=$(scan -l --fixed-strings -- "$TOKEN" -- ':!scripts/secret_scan.sh')
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
URL_HITS=$(scan -nE -- 'macros/s/[A-Za-z0-9_-]{30,}' -- .)
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
#
# This is the check that has to catch a GEMINI key, so the shape was confirmed
# rather than assumed: a Gemini key is "AIzaSy" plus 33 more characters, 39 in
# total, which is exactly AIza + 35. The key belongs in the Edge Function's own
# secrets and nowhere else — never in app.js, index.html, vendor/ or sw.js, all
# of which are served verbatim from a public repo.
KEY_HITS=$(scan -nE -- 'AIza[0-9A-Za-z_-]{35}|GOCSPX-[0-9A-Za-z_-]{28}' -- ':!scripts/secret_scan.sh')
if [ -n "$KEY_HITS" ]; then
  fail "Google API key / OAuth secret committed:"
  printf '        %s\n' "$KEY_HITS"
else
  pass "no Google API key or OAuth secret (incl. Gemini) in tracked files"
fi

# --- 5. the Supabase key that ships must be the ANON one ---------------------
# The project URL and anon key are committed DELIBERATELY (app.js), so that
# reinstalling means signing in with GitHub rather than retyping a 209-character
# key on a phone. They identify the project; they do not grant access to it —
# row level security and the sign-in do that. What must never ship is a key
# claiming any stronger role, so check the shape of what is actually there.
if [ -n "$(scan -lIE -- 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}' -- '*.js' '*.html')" ]; then
  BAD=0
  for TOK in $(scan -hoIE -- 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{100,}' -- '*.js' '*.html'); do
    BODY=$(printf '%s' "$TOK" | cut -d. -f2)
    PAD=$(( (4 - ${#BODY} % 4) % 4 ))
    DEC=$(printf '%s%s' "$BODY" "$(printf '=%.0s' $(seq 0 $PAD) 2>/dev/null)" \
          | tr '_-' '/+' | base64 -d 2>/dev/null || true)
    case "$DEC" in
      *'"role":"anon"'*) : ;;
      *) BAD=1 ;;
    esac
  done
  if [ "$BAD" -eq 1 ]; then
    fail "a project token in a tracked file claims a role other than anon"
  else
    pass "committed Supabase token is the anon key (deliberate, and safe)"
  fi
else
  pass "no Supabase token in tracked files"
fi

# --- 6. the Supabase service_role key ----------------------------------------
# Unlike the anon key, this one bypasses row level security entirely — it can
# read and delete everything. It lives only in ~/.probeing/, never here.
if [ -f "$HOME/.probeing/supabase_service.txt" ]; then
  SVC=$(tr -d '\n' < "$HOME/.probeing/supabase_service.txt")
  if [ -n "$SVC" ] && [ -n "$(scan -lI -- "$SVC")" ]; then
    fail "Supabase SERVICE key present in a tracked file"
  else
    pass "Supabase service key absent from tracked files"
  fi
fi
SVC_SHAPE=$(scan -nIE -- '"?role"?\s*:\s*"service_role"')
if [ -n "$SVC_SHAPE" ]; then
  fail "something claiming service_role is in a tracked file"
  printf '%s\n' "$SVC_SHAPE" | head -3
else
  pass "no service_role credential shape in tracked files"
fi

# --- 7. history, not just the working tree ----------------------------------
# A secret removed in a later commit is still public in an earlier one.
if [ "$QUICK" -eq 0 ] && git rev-parse HEAD >/dev/null 2>&1; then
  HIST_BAD=0
  if [ -r "$TOKEN_FILE" ] && [ ${#TOKEN} -ge 12 ]; then
    HIST_TOKEN=$(git log -S"$TOKEN" --oneline --all 2>/dev/null)
    if [ -n "$HIST_TOKEN" ]; then
      fail "live TOKEN appears somewhere in committed history"
      HIST_BAD=1
    fi
  fi
  # A Gemini key pasted into a file and removed in the next commit is still
  # readable forever by anyone who clones. --pickaxe-regex, because the shape is
  # what we know; the key itself is not on this machine to compare against.
  HIST_GEM=$(git log -S'AIza[0-9A-Za-z_-]{35}' --pickaxe-regex --oneline --all \
               -- . ':!scripts/secret_scan.sh' 2>/dev/null)
  if [ -n "$HIST_GEM" ]; then
    fail "a Gemini-shaped API key appears in committed history"
    printf '        %s\n' "$HIST_GEM" | head -3
    printf '        A key in history is a leaked key: rotate it, do not just remove it.\n' 
    printf '        %s\n' "rotate that key in Google AI Studio — deleting the commit is not enough"
    HIST_BAD=1
  fi
  HIST_URL=$(git log -S'macros/s/' --oneline --all -- . 2>/dev/null | head -3)
  if [ -n "$HIST_URL" ]; then
    # Only fail on a real-length id, not the placeholder in docs.
    if git grep -qE 'macros/s/[A-Za-z0-9_-]{30,}' $(git rev-list --all) -- . 2>/dev/null; then
      fail "real Apps Script URL appears in committed history:"
      printf '        %s\n' "$HIST_URL"
      HIST_BAD=1
    fi
  fi
  # The service_role key is the one credential that bypasses row level security
  # outright, so history matters more here than anywhere else — yet this section
  # checked for a Gemini key and not for this. Two ways in, because either alone
  # misses a real case: by VALUE, which needs the key to still be on this machine,
  # and by SHAPE, which does not.
  if [ -n "${SVC:-}" ]; then
    HIST_SVC=$(git log -S"$SVC" --oneline --all 2>/dev/null)
    if [ -n "$HIST_SVC" ]; then
      fail "the Supabase SERVICE key appears in committed history"
      printf '        %s\n' "$HIST_SVC" | head -3
      printf '        %s\n' "rotate it in the Supabase dashboard — removing the commit is not enough"
      HIST_BAD=1
    fi
  fi
  # A JWT payload is base64url, so the literal text "service_role" never appears
  # in it. These three fragments are that string encoded at each of the three
  # possible byte alignments, which is every way it can land inside a real token.
  # Confirmed against the live key (matches) and the anon key (does not).
  HIST_SVC_SHAPE=$(git log --oneline --all --pickaxe-regex \
      -S'InJvbGUiOiJzZXJ2aWNlX3Jv|b2xlIjoic2VydmljZV9yb2|cm9sZSI6InNlcnZpY2Vfcm9|"?role"?[[:space:]]*:[[:space:]]*"service_role"' \
      -- . ':!scripts/secret_scan.sh' 2>/dev/null)
  if [ -n "$HIST_SVC_SHAPE" ]; then
    fail "a service_role credential shape appears in committed history"
    printf '        %s\n' "$HIST_SVC_SHAPE" | head -3
    HIST_BAD=1
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
