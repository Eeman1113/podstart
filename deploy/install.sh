#!/usr/bin/env bash
#
# podstart — self-hosted Supabase installer
#
# Installs a complete Supabase stack into a directory of its own and wires
# podstart's schema into it.
#
# The operating rule of this script is that it owns exactly one directory and
# nothing else. It will not stop, restart, reconfigure or upgrade anything that
# was already running on the machine. Every container it creates belongs to the
# Compose project "podstart", every port it binds is checked for a conflict
# first and bound to localhost only, and the reverse proxy is left for you to
# edit after reading a snippet it prints.
#
#   ./install.sh --audit     Report what is on this host. Changes nothing.
#   ./install.sh             Install into /database.
#   ./install.sh --dir /srv/x --project myname
#
set -euo pipefail

DIR="/database"
PROJECT="podstart"
# Pinned so a future upstream change cannot alter what this installs.
SUPABASE_REF="${SUPABASE_REF:-master}"
AUDIT_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --audit)   AUDIT_ONLY=true; shift ;;
    --dir)     DIR="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --ref)     SUPABASE_REF="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------- audit

bold "== host =="
hostname
grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || true
echo "kernel  $(uname -r)"
echo "cpus    $(nproc)"
free -h 2>/dev/null | awk 'NR==2 {print "memory  " $3 " used of " $2}'
df -h "$(dirname "$DIR")" 2>/dev/null | awk 'NR==2 {print "disk    " $4 " free on " $6}'
echo

bold "== already running (left alone) =="
if command -v docker >/dev/null 2>&1; then
  docker ps --format '  {{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || echo "  (cannot read docker)"
  echo
  echo "  compose projects:"
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
    | grep -v '^$' | sort -u | sed 's/^/    /' || true
else
  echo "  docker not installed"
fi
echo

bold "== listening ports =="
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | awk 'NR>1 {print "  " $4 "  " $6}' | sort -u
else
  netstat -tlnp 2>/dev/null | awk 'NR>2 {print "  " $4 "  " $7}' | sort -u || true
fi
echo

bold "== reverse proxy =="
for unit in caddy nginx apache2 traefik; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    echo "  $unit is running"
  fi
done
[[ -f /etc/caddy/Caddyfile ]] && echo "  Caddyfile at /etc/caddy/Caddyfile"
echo

if [[ "$AUDIT_ONLY" == true ]]; then
  bold "Audit only — nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------- preflight

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it first; this script will not."
docker compose version >/dev/null 2>&1 || fail "The docker compose plugin is missing."
command -v git >/dev/null 2>&1 || fail "git is required to fetch the Supabase stack."
command -v node >/dev/null 2>&1 || fail "node is required to generate the keys."

if [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
  fail "$DIR already exists and is not empty. Refusing to write into it. Move it aside or pass --dir."
fi

if docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -qx "$PROJECT"; then
  fail "A compose project named '$PROJECT' already exists. Pass --project <other-name>."
fi

# Finds a free localhost port at or above a preferred one, so nothing already
# bound is ever displaced.
free_port() {
  local port="$1"
  while ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$"; do
    port=$((port + 1))
  done
  echo "$port"
}

KONG_PORT=$(free_port 8000)
DB_PORT=$(free_port 5432)
STUDIO_PORT=$(free_port 3000)
ANALYTICS_PORT=$(free_port 4000)
POOLER_PORT=$(free_port 6543)

bold "== ports chosen (all bound to 127.0.0.1 only) =="
echo "  api / kong   $KONG_PORT"
echo "  postgres     $DB_PORT"
echo "  studio       $STUDIO_PORT"
echo "  analytics    $ANALYTICS_PORT"
echo "  pooler       $POOLER_PORT"
echo

read -rp "Proceed and install into $DIR? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || fail "Aborted. Nothing was changed."

# --------------------------------------------------------------------- fetch

bold "Fetching the Supabase stack…"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --quiet --depth 1 --filter=blob:none --sparse \
  --branch "$SUPABASE_REF" https://github.com/supabase/supabase.git "$TMP/supabase"
git -C "$TMP/supabase" sparse-checkout set --no-cone docker >/dev/null

cp -r "$TMP/supabase/docker/." "$DIR/"
rm -f "$DIR/README.md"
echo "  installed from supabase@$(git -C "$TMP/supabase" rev-parse --short HEAD)"

# ----------------------------------------------------------------- configure

bold "Generating secrets…"
SECRETS="$DIR/.secrets.env"
node "$(dirname "$0")/keys.mjs" > "$SECRETS"
chmod 600 "$SECRETS"
# shellcheck disable=SC1090
set -a; source "$SECRETS"; set +a

API_URL="${PODSTART_API_URL:-http://localhost:$KONG_PORT}"

cp "$DIR/.env.example" "$DIR/.env"
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$DIR/.env"; then
    # The value can contain slashes and ampersands, so use a delimiter that
    # cannot appear in base64url or hex.
    sed -i "s|^${key}=.*|${key}=${value}|" "$DIR/.env"
  else
    echo "${key}=${value}" >> "$DIR/.env"
  fi
}

set_env POSTGRES_PASSWORD   "$POSTGRES_PASSWORD"
set_env JWT_SECRET          "$JWT_SECRET"
set_env ANON_KEY            "$ANON_KEY"
set_env SERVICE_ROLE_KEY    "$SERVICE_ROLE_KEY"
set_env DASHBOARD_USERNAME  "$DASHBOARD_USERNAME"
set_env DASHBOARD_PASSWORD  "$DASHBOARD_PASSWORD"
set_env SECRET_KEY_BASE     "$SECRET_KEY_BASE"
set_env VAULT_ENC_KEY       "$VAULT_ENC_KEY"

set_env POSTGRES_PORT       "$DB_PORT"
set_env KONG_HTTP_PORT      "$KONG_PORT"
set_env KONG_HTTPS_PORT     "$(free_port 8443)"
set_env STUDIO_PORT         "$STUDIO_PORT"
set_env ANALYTICS_HOST_PORT "$ANALYTICS_PORT"
set_env POOLER_PROXY_PORT_TRANSACTION "$POOLER_PORT"

set_env API_EXTERNAL_URL    "$API_URL"
set_env SUPABASE_PUBLIC_URL "$API_URL"
set_env SITE_URL            "${PODSTART_SITE_URL:-$API_URL}"

# podstart needs anonymous sign-in: the room code is the credential, and a
# guest should never have to make an account to record.
set_env ENABLE_ANONYMOUS_USERS true
set_env DISABLE_SIGNUP         false
# No mail server here, so confirmations would strand every sign-up.
set_env ENABLE_EMAIL_AUTOCONFIRM true

# Keep every service on loopback. The reverse proxy is the only way in.
sed -i -E 's|^(\s+)- \$\{(KONG_HTTP_PORT|STUDIO_PORT|POSTGRES_PORT|ANALYTICS_HOST_PORT)\}:|\1- 127.0.0.1:${\2}:|' \
  "$DIR/docker-compose.yml" 2>/dev/null || true

chmod 600 "$DIR/.env"

# ------------------------------------------------------------------- migrate

bold "Staging podstart's migrations…"
mkdir -p "$DIR/podstart-migrations"
if [[ -d "$(dirname "$0")/../supabase/migrations" ]]; then
  cp "$(dirname "$0")/../supabase/migrations/"*.sql "$DIR/podstart-migrations/"
  echo "  $(ls -1 "$DIR/podstart-migrations" | wc -l) migrations staged"
else
  warn "  migrations not found next to this script — copy them into $DIR/podstart-migrations yourself"
fi

# --------------------------------------------------------------------- start

bold "Starting the stack (compose project: $PROJECT)…"
cd "$DIR"
docker compose -p "$PROJECT" up -d

echo "  waiting for the database…"
for _ in $(seq 1 60); do
  if docker compose -p "$PROJECT" exec -T db pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

bold "Applying podstart's schema…"
for file in "$DIR"/podstart-migrations/*.sql; do
  [[ -e "$file" ]] || continue
  echo "  $(basename "$file")"
  docker compose -p "$PROJECT" exec -T db \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$file"
done

# ------------------------------------------------------------------- report

cat > "$DIR/podstart-frontend.env" <<ENVFILE
# Paste these into the podstart repo as GitHub Actions *variables*.
# The anon key is public by design: row-level security, not secrecy, is what
# protects the data.
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
ENVFILE
chmod 600 "$DIR/podstart-frontend.env"

cat > "$DIR/caddy-snippet.conf" <<CADDY
# Add this to your Caddyfile as a NEW block. Do not edit existing blocks.
# Then: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
#
# Replace the hostname if you are using a different one.

${PODSTART_PUBLIC_HOST:-supabase.example.com} {
	# Audio stems are uploaded in segments; the default body limit is far
	# below a segment and would reject every one of them.
	request_body {
		max_size 64MB
	}

	reverse_proxy 127.0.0.1:$KONG_PORT {
		# Realtime is a websocket; these keep it from being cut mid-take.
		flush_interval -1
	}
}
CADDY

echo
bold "== done =="
echo "Stack:      $DIR  (compose project: $PROJECT)"
echo "API:        http://127.0.0.1:$KONG_PORT   -> expose via $DIR/caddy-snippet.conf"
echo "Studio:     http://127.0.0.1:$STUDIO_PORT (ssh -L to reach it)"
echo "Secrets:    $DIR/.secrets.env             (0600, back this up)"
echo "Frontend:   $DIR/podstart-frontend.env    (the two values GitHub Actions needs)"
echo
warn "Nothing outside $DIR was modified. The Caddy block is yours to add after reading it."
