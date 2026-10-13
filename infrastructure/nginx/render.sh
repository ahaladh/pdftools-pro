#!/usr/bin/env bash
# Render pdftools-vps.conf.template into a concrete nginx config.
#   DOMAIN=pdf.example.com WEB_ROOT=/var/www/pdftools ./render.sh > /etc/nginx/conf.d/pdftools.conf
# Optional: API_ADDR (127.0.0.1:4000) CERT KEY SNIPPETS (/etc/nginx/snippets) HTTP_PORT (80) HTTPS_PORT (443)
#           MAX_UPLOAD (1g) ACCESS_LOG (/var/log/nginx/pdftools.access.log)
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"; : "${WEB_ROOT:?set WEB_ROOT}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid DOMAIN" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
CERT="${CERT:-/etc/letsencrypt/live/$DOMAIN/fullchain.pem}"; KEY="${KEY:-/etc/letsencrypt/live/$DOMAIN/privkey.pem}"
sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__WEB_ROOT__#$WEB_ROOT#g" -e "s#__API_ADDR__#${API_ADDR:-127.0.0.1:4000}#g" \
    -e "s#__CERT__#$CERT#g" -e "s#__KEY__#$KEY#g" -e "s#__SNIPPETS__#${SNIPPETS:-/etc/nginx/snippets}#g" \
    -e "s#__HTTP_PORT__#${HTTP_PORT:-80}#g" -e "s#__HTTPS_PORT__#${HTTPS_PORT:-443}#g" -e "s#__MAX_UPLOAD__#${MAX_UPLOAD:-1g}#g" \
    -e "s#__ACCESS_LOG__#${ACCESS_LOG:-/var/log/nginx/pdftools.access.log}#g" "$here/pdftools-vps.conf.template"
