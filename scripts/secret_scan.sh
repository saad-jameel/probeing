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
# The project URL and anon key are committed DELIBERATELY (app.js, and since
# Stage 8 the widget's Supabase.java too), so that reinstalling means signing in
# with GitHub rather than retyping a 209-character key on a phone. They identify
# the project; they do not grant access to it — row level security and the
# sign-in do that. What must never ship is a key claiming any stronger role, so
# check the shape of what is actually there.
#
# The .java and .xml paths were added when the Android wrapper landed: the same
# key now ships in a second language, and a check that only reads *.js would be a
# check the APK walks straight past.
if [ -n "$(scan -lIE -- 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}' -- '*.js' '*.html' '*.java' '*.xml')" ]; then
  BAD=0
  for TOK in $(scan -hoIE -- 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{100,}' -- '*.js' '*.html' '*.java' '*.xml'); do
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

# --- 7. the VAPID pair, and the cron secret (Stage 7a) -----------------------
# The push notification keys are a PAIR, and the two halves have opposite rules.
#
# The PUBLIC half is hard-coded in app.js on purpose, exactly like the Supabase
# anon key above it: it names the sender, it can only ever CHECK a signature, and
# the browser needs it before any network call has happened. So this section does
# not flag it — it checks that what is committed really is the public half. A
# P-256 public key is a 65-byte point beginning 0x04; a private key is not, and
# pasting one where the other belongs is the mistake worth catching here.
#
# The PRIVATE half and the cron secret live only in ~/.probeing/ and in Supabase's
# secret store. The private key can forge a push from ProBeing to any device that
# has ever subscribed; the cron secret can make the wrapup function write rows as
# you, at any hour it likes.
VAPID_IN_APP=$(scan -hoE -- "VAPID_PUBLIC_KEY = '[A-Za-z0-9_-]{80,}'" -- '*.js' '*.html')
if [ -n "$VAPID_IN_APP" ]; then
  VAPID_KEY=$(printf '%s' "$VAPID_IN_APP" | head -1 | sed "s/.*'\(.*\)'.*/\1/")
  # Decoded by hand, because the shape IS the check: 65 bytes starting 0x04.
  VPAD=$(( (4 - ${#VAPID_KEY} % 4) % 4 ))
  VBYTES=$(printf '%s%s' "$VAPID_KEY" "$(printf '=%.0s' $(seq 1 $VPAD) 2>/dev/null)" \
           | tr '_-' '/+' | base64 -d 2>/dev/null | od -An -tu1 | tr -s ' ' '\n' | grep -c .)
  VFIRST=$(printf '%s%s' "$VAPID_KEY" "$(printf '=%.0s' $(seq 1 $VPAD) 2>/dev/null)" \
           | tr '_-' '/+' | base64 -d 2>/dev/null | od -An -tu1 -N1 | tr -d ' ')
  if [ "$VBYTES" = "65" ] && [ "$VFIRST" = "4" ]; then
    pass "committed VAPID key is the PUBLIC half (65-byte P-256 point) — deliberate, and safe"
  else
    fail "the VAPID key in a tracked file is not a 65-byte public point ($VBYTES bytes, first byte $VFIRST)"
    printf '        %s\n' "if that is the PRIVATE key, rotate it: node scripts/make_vapid.js"
  fi
else
  pass "no VAPID key in tracked files"
fi

# By value: the two files this machine holds must appear in nothing tracked.
for pair in "vapid_private.txt:VAPID private key" "cron_secret.txt:cron secret"; do
  SFILE="$HOME/.probeing/${pair%%:*}"
  SWHAT="${pair#*:}"
  if [ -r "$SFILE" ]; then
    SVAL=$(tr -d '[:space:]' < "$SFILE")
    if [ ${#SVAL} -ge 20 ]; then
      SHITS=$(scan -lI --fixed-strings -- "$SVAL")
      if [ -n "$SHITS" ]; then
        fail "the $SWHAT is in a tracked file:"
        printf '        %s\n' $SHITS
      else
        pass "$SWHAT absent from tracked files"
      fi
    fi
  fi
done

# By shape, which works even on a machine that does not hold the files. The
# prefix below is the DER header every P-256 PKCS#8 private key starts with —
# confirmed against the one scripts/make_vapid.js writes, not guessed.
KEY_SHAPE=$(scan -nIE -- 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEH|BEGIN (EC )?PRIVATE KEY' \
            -- . ':!scripts/secret_scan.sh')
if [ -n "$KEY_SHAPE" ]; then
  fail "a private key is in a tracked file:"
  printf '        %s\n' "$KEY_SHAPE" | head -3
else
  pass "no private key shape in tracked files"
fi

# --- 9. the Android signing key, and the APK it signs (Stage 8) --------------
# The APK is signed with a key that lives in ~/.probeing/, exactly like the token
# and the VAPID private half. Anyone holding it can build a package Android will
# accept as an UPDATE to ProBeing, and install it over the real one.
#
# It is also the one credential here that cannot be rotated quietly. A
# differently-signed APK is a DIFFERENT APP to Android: recovering from a leak
# means uninstalling, losing the widget's pairing, and setting it up again.
#
# NOT A SECRET, AND NOBODY SHOULD "FIX" IT: the certificate FINGERPRINT in
# android/assetlinks.json is public BY DESIGN. That file is meant to be served
# from a public website, because it is how Chrome decides this APK may open that
# origin without a URL bar. A fingerprint is a hash of the PUBLIC certificate and
# cannot be turned back into a key. Flagging it would break the app to no gain.
#
# Three checks, because each one alone can be walked past: by NAME, which anyone
# can spot; by MAGIC BYTES, because renaming the file to notes.txt defeats the
# name check; and by the PASSWORD's own value, which is the likelier accident —
# a password pasted into a build file to make a build work.
KS_EXT_RE='\.(jks|keystore|p12|pfx|apk|aab)$'
KS_TRACKED=$(git ls-files | grep -iE "$KS_EXT_RE" || true)
if [ -n "$KS_TRACKED" ]; then
  fail "a keystore or a built app is tracked by git:"
  printf '        %s\n' $KS_TRACKED
else
  pass "no keystore or APK/AAB tracked by extension"
fi

# Reads a tracked file from disk, or from the index when it is staged but not on
# disk — the same two places scan() looks, and for the same reason.
bytes_of() { if [ -f "$1" ]; then cat -- "$1"; else git show ":$1" 2>/dev/null; fi; }

# A Java keystore starts FE ED FE ED; the JCEKS variant starts CE CE CE CE. A
# PKCS#12 is DER, which starts 30 82 — far too common a shape to flag on its own,
# since every certificate and every signature block begins that way. So a DER
# file is only flagged when the pkcs-12 object identifier (1.2.840.113549.1.12)
# is actually in its bytes.
#
# `grep -c`, never `grep -q`: see the note at the top of this file. -c reads to
# the end, so it cannot close the pipe early and turn a match into a silent pass.
P12_OID=$(printf '\052\206\110\206\367\015\001\014')
KS_MAGIC=''
while IFS= read -r f; do
  [ -n "$f" ] || continue
  HEAD4=$(bytes_of "$f" | head -c 4 | od -An -tx1 | tr -d ' \n')
  case "$HEAD4" in
    feedfeed|cececece) KS_MAGIC="$KS_MAGIC $f" ;;
    3082*)
      OIDHIT=$(bytes_of "$f" | LC_ALL=C grep -acF -- "$P12_OID" 2>/dev/null || true)
      [ "${OIDHIT:-0}" != "0" ] && KS_MAGIC="$KS_MAGIC $f"
      ;;
  esac
done <<< "$(git ls-files)"
if [ -n "$KS_MAGIC" ]; then
  fail "a file with keystore magic bytes is tracked (whatever it is named):"
  printf '        %s\n' $KS_MAGIC
else
  pass "no keystore magic bytes (FE ED FE ED / PKCS#12) in tracked files"
fi

# By value. The passwords live in ~/.probeing/keystore.properties, mode 0600, and
# must appear in nothing tracked — not in app/build.gradle, not in a README.
KS_PROPS="$HOME/.probeing/keystore.properties"
if [ -r "$KS_PROPS" ]; then
  # ONE PASSWORD PER LINE, and the reason is a bug this check shipped with.
  #
  # It used to end `| cut -d= -f2- | tr -d '[:space:]' | sort -u`, and
  # [:space:] INCLUDES THE NEWLINE. With both storePassword and keyPassword in
  # the file, tr joined the two values into a single 64-character string — so
  # the scan searched for the password written TWICE, end to end, which appears
  # nowhere on earth. It reported "absent" every time, and planting the real
  # password in a tracked file did not trip it. A gate that cannot fail is not
  # a gate; this one could only fail on a string that cannot exist.
  #
  # sed keeps the line structure and strips only blanks around the value. The
  # earlier single-value checks (token, VAPID, cron secret) read a whole file
  # with one value in it, so `tr -d '[:space:]'` is correct there and is left
  # alone.
  KS_PWS=$(sed -nE 's/^[[:space:]]*(storePassword|keyPassword)[[:space:]]*=[[:space:]]*(.*)$/\2/p' \
             "$KS_PROPS" | tr -d '\r' | sed -E 's/[[:space:]]+$//' | sort -u)
  # The length floor exists because a short password is mostly common words and
  # would match half the repo. But SKIPPING a password and then printing "ok"
  # is the gate lying: it reports the thing it did not look for as absent. So
  # count what was actually checked, and fail loudly if that count is zero —
  # an unscannable password is a blind spot over the one credential here that
  # cannot be rotated without breaking the published assetlinks.json.
  KS_PW_BAD=0
  KS_PW_CHECKED=0
  while IFS= read -r KPW; do
    if [ ${#KPW} -lt 12 ]; then
      continue
    fi
    KS_PW_CHECKED=$((KS_PW_CHECKED + 1))
    KPW_HITS=$(scan -lI --fixed-strings -- "$KPW")
    if [ -n "$KPW_HITS" ]; then
      fail "the keystore password is in a tracked file:"
      printf '        %s\n' $KPW_HITS
      KS_PW_BAD=1
    fi
  done <<< "$KS_PWS"
  if [ "$KS_PW_CHECKED" -eq 0 ]; then
    fail "the keystore password is too short (< 12 chars) to scan for — this check did NOT run"
    printf '        %s\n' "lengthen it: keytool -storepasswd -keystore <ks>, then update keystore.properties"
  elif [ "$KS_PW_BAD" -eq 0 ]; then
    pass "keystore password absent from tracked files ($KS_PW_CHECKED checked)"
  fi
else
  pass "no local keystore.properties to compare against (skipped)"
fi

# --- 8. history, not just the working tree ----------------------------------
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
  # Stage 7a's two. A key removed in the next commit is still public in this
  # one, and the VAPID private key is the one credential here that cannot be
  # rotated without silently unsubscribing every device.
  for pair in "vapid_private.txt:VAPID private key" "cron_secret.txt:cron secret"; do
    HFILE="$HOME/.probeing/${pair%%:*}"
    HWHAT="${pair#*:}"
    if [ -r "$HFILE" ]; then
      HVAL=$(tr -d '[:space:]' < "$HFILE")
      if [ ${#HVAL} -ge 20 ]; then
        HIST_ONE=$(git log -S"$HVAL" --oneline --all 2>/dev/null)
        if [ -n "$HIST_ONE" ]; then
          fail "the $HWHAT appears in committed history"
          printf '        %s\n' "$HIST_ONE" | head -3
          HIST_BAD=1
        fi
      fi
    fi
  done
  HIST_PRIV=$(git log -S'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEH' --pickaxe-regex --oneline --all \
                -- . ':!scripts/secret_scan.sh' 2>/dev/null)
  if [ -n "$HIST_PRIV" ]; then
    fail "a P-256 private key appears in committed history"
    printf '        %s\n' "$HIST_PRIV" | head -3
    printf '        %s\n' "regenerate the VAPID pair and re-subscribe both devices; removing the commit is not enough"
    HIST_BAD=1
  fi

  # Stage 8's keystore, in history. A keystore deleted in a later commit is
  # still a usable signing key in an earlier one, and --diff-filter=A is how a
  # file that was ADDED and then removed is still found by name.
  HIST_KS=$(git log --all --diff-filter=A --pretty=format:'' --name-only \
              -- '*.jks' '*.keystore' '*.p12' '*.pfx' '*.apk' '*.aab' 2>/dev/null \
            | sort -u | grep -v '^$' || true)
  if [ -n "$HIST_KS" ]; then
    fail "a keystore or built app was added somewhere in committed history:"
    printf '        %s\n' $HIST_KS
    printf '        %s\n' "a signing key in history is a leaked key: generate a new one, and note that"
    printf '        %s\n' "the phone must uninstall before it will accept an APK signed by the new key"
    HIST_BAD=1
  fi
  if [ -r "$KS_PROPS" ]; then
    while IFS= read -r KPW; do
      [ ${#KPW} -ge 12 ] || continue
      HIST_KPW=$(git log -S"$KPW" --oneline --all 2>/dev/null)
      if [ -n "$HIST_KPW" ]; then
        fail "the keystore password appears in committed history"
        printf '        %s\n' "$HIST_KPW" | head -3
        HIST_BAD=1
      fi
    done <<< "$KS_PWS"
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
