#!/usr/bin/env bash
# Install PDFTools Pro on a fresh Ubuntu VPS (Hostinger VPS, or any Ubuntu 22.04/24.04 server) with Docker Compose + Caddy (automatic HTTPS).
#
#   1. Put your filled-in env file on the server:   scp .env.hostinger root@YOUR_SERVER_IP:/root/pdftools.env
#   2. On the server, as root:
#        curl -fsSL <raw URL of this script>  -o install.sh      (or copy it over with scp)
#        REPO_URL=https://<token>@github.com/ahaladh/pdftools-pro.git bash install.sh
#      REPO_URL for a PRIVATE repo needs a token (GitHub > Settings > Developer settings > fine-grained token, read-only "Contents"
#      on this repo) or an SSH deploy key (git@github.com:ahaladh/pdftools-pro.git with the key set up first).
#   Re-running it updates the code and redeploys (your env file and data are kept).
#
# Not tested on a real Hostinger server: it is written from Docker's and Hostinger's documented behaviour. Read the output; it stops at the
# first problem and says what to fix. Environment: REPO_URL (required first time), BRANCH (default master), APP_DIR (default /opt/pdftools),
# ENV_FILE (default /root/pdftools.env, only read when APP_DIR/.env does not exist yet).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pdftools}"
BRANCH="${BRANCH:-master}"
ENV_FILE="${ENV_FILE:-/root/pdftools.env}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.tls.yml)

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo -i, then run this again)"
command -v apt-get >/dev/null || die "this script is for Ubuntu/Debian servers (apt-get not found)"

say "1/7 Checking the server"
mem_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "memory ${mem_mb} MB, free disk ${disk_gb} GB"
[ "$mem_mb" -ge 3500 ] || warn "under 4 GB of memory: building the web image (it runs Chromium) may run out of memory. Add swap (fallocate -l 4G /swapfile; chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile) or use a bigger plan."
[ "$disk_gb" -ge 15 ] || die "less than 15 GB free disk: the images need room to build"

say "2/7 Docker"
if ! command -v docker >/dev/null; then
  echo "Docker is not installed: installing it with Docker's official script (get.docker.com)"
  command -v curl >/dev/null || apt-get install -y curl
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (docker compose version failed). Install the docker-compose-plugin package."
systemctl enable --now docker >/dev/null 2>&1 || true

say "3/7 The code"
command -v git >/dev/null || apt-get install -y git
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH" || die "the code in $APP_DIR has local changes that block the update; look at: git -C $APP_DIR status"
else
  [ -n "${REPO_URL:-}" ] || die "first install: set REPO_URL (see the top of this script), for example REPO_URL=https://TOKEN@github.com/ahaladh/pdftools-pro.git bash install.sh"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  # do not leave a token in the stored remote URL
  git -C "$APP_DIR" remote set-url origin "$(printf '%s' "$REPO_URL" | sed -E 's#(https?://)[^@/]+@#\1#')"
fi
cd "$APP_DIR"
echo "deploying commit $(git rev-parse --short HEAD)"

say "4/7 Settings"
if [ ! -f .env ]; then
  [ -f "$ENV_FILE" ] || die "no settings file. Copy your filled-in .env.hostinger to the server as $ENV_FILE (scp), then run this again."
  install -m 600 "$ENV_FILE" .env
fi
chmod 600 .env
if grep -v '^[[:space:]]*#' .env | grep -q CHANGE_ME; then
  grep -v '^[[:space:]]*#' .env | grep -n CHANGE_ME | sed 's/=.*/=.../' || true
  die "the lines above still say CHANGE_ME in $APP_DIR/.env: edit them (nano $APP_DIR/.env) and run this again"
fi
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
SITE_URL=$(get SITE_URL); DOMAIN=$(get SITE_ADDRESS)
case "$SITE_URL" in https://*) ;; *) die "SITE_URL must start with https:// (it is: $SITE_URL)";; esac
[ -n "$(get MONGO_PASSWORD)" ] && [ -n "$(get JWT_ACCESS_SECRET)" ] && [ -n "$(get DOWNLOAD_SECRET)" ] || die "MONGO_PASSWORD, JWT_ACCESS_SECRET and DOWNLOAD_SECRET must be set in .env"
[ -n "$(get SMTP_URL)" ] || warn "SMTP_URL is empty: password-reset and confirmation emails cannot be sent (set it later, then re-run this script)"
[ -n "$(get ADMIN_PASSWORD)" ] || warn "ADMIN_PASSWORD is empty: fine if the admin already exists, otherwise there is no administrator yet"

say "5/7 Does the domain point here?"
resolved=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -z "$resolved" ]; then
  die "$DOMAIN does not resolve yet. Create the DNS A record for it pointing at this server's IP, wait a few minutes, and run this again (Caddy cannot get the HTTPS certificate otherwise)."
elif ! hostname -I | tr ' ' '\n' | grep -qx "$resolved"; then
  warn "$DOMAIN resolves to $resolved, which is not an address of this server ($(hostname -I | awk '{print $1}')). If that is a proxy/CDN or NAT, ignore this; otherwise fix the DNS record or the certificate will fail."
fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 22/tcp >/dev/null
  echo "firewall: ports 22, 80 and 443 are open"
fi

say "6/7 Building and starting (the first build takes 10 to 20 minutes)"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d
echo "waiting for the services to become healthy..."
for i in $(seq 1 60); do
  unhealthy=$("${COMPOSE[@]}" ps --format '{{.Name}} {{.Health}} {{.State}}' | grep -vE ' healthy |^\S+ +running$' | grep -v 'caddy' || true)
  [ -z "$unhealthy" ] && break
  sleep 5
done
"${COMPOSE[@]}" ps

say "7/7 Checking it"
"${COMPOSE[@]}" exec -T api node apps/api/dist/doctor.js || warn "doctor reported problems (above). Warnings about mail or payments are expected until you configure them."
for i in $(seq 1 24); do
  if curl -fsS -o /dev/null "$SITE_URL/"; then ok=1; break; fi
  sleep 5
done
if [ "${ok:-0}" = 1 ]; then echo "OK: $SITE_URL answers"; else warn "$SITE_URL did not answer yet. HTTPS can take a minute after the first start: docker compose logs caddy"; fi

cat <<EOF

Done. Next:
  1. Open $SITE_URL and sign in with ADMIN_EMAIL / ADMIN_PASSWORD from the settings file (you are asked to set up two-step sign-in).
  2. DELETE the ADMIN_PASSWORD line from $APP_DIR/.env, then run this script again (it redeploys with it removed).
  3. Payments: enable Subscriptions in Razorpay, fill RAZORPAY_* in .env, set the webhook to $SITE_URL/api/billing/razorpay/webhook, run this script again.
  4. Backups: see docs/OPERATIONS.md ("Backups and recovery"). Back up the caddy-data volume too.
Update later: run this script again. Logs: cd $APP_DIR && docker compose -f docker-compose.yml -f docker-compose.tls.yml logs -f api
EOF
