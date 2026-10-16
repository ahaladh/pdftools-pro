#!/usr/bin/env bash
# Install the OPTIONAL engines (Tesseract for OCR, veraPDF for PDF/A validation) into a user directory, no root needed.
# Usage:  eval "$(infrastructure/scripts/dev-engines.sh)"     # installs on first run, then exports the settings
# Production images install these via apt / the Dockerfile instead; this is for development and CI-less machines.
# Needs: apt-get (download only), dpkg, curl, unzip, java 11+.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${PDFTOOLS_ENGINE_CACHE:-$HOME/.cache/pdftools}"
VERAPDF_VERSION="${VERAPDF_VERSION:-1.30.3}"
VERAPDF_SHA256="${VERAPDF_SHA256:-b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59}"
mkdir -p "$CACHE"
log() { echo "[dev-engines] $*" >&2; }

T="$CACHE/tess"
USER_TESS=0
if command -v tesseract >/dev/null 2>&1 && [ -z "${FORCE_USER_TESSERACT:-}" ]; then
  log "tesseract already on PATH: $(command -v tesseract)"
else
  USER_TESS=1
  if [ ! -x "$T/root/usr/bin/tesseract" ]; then
    log "installing Tesseract into $T (download only, no root)"
    mkdir -p "$T" && ( cd "$T" && apt-get download tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd libtesseract4 liblept5 >&2 && for d in *.deb; do dpkg -x "$d" root; done )
  fi
  TESSDATA="$(ls -d "$T"/root/usr/share/tesseract-ocr/*/tessdata | head -1)"
fi

V="$CACHE/verapdf"
if [ ! -x "$V/app/verapdf" ]; then
  command -v java >/dev/null || { log "veraPDF needs Java (e.g. apt install default-jre-headless)"; exit 1; }
  log "installing veraPDF $VERAPDF_VERSION into $V"
  mkdir -p "$V"
  (
    cd "$V"
    curl -fsSL -o inst.zip "https://software.verapdf.org/rel/${VERAPDF_VERSION%.*}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip"
    echo "$VERAPDF_SHA256  inst.zip" | sha256sum -c - >&2
    unzip -oq inst.zip
    sed "s#/opt/verapdf#$V/app#" "$HERE/../docker/verapdf-install.xml" > auto-install.xml
    java -jar "verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" auto-install.xml >&2
    rm -f inst.zip
  )
fi

if [ "$USER_TESS" = 1 ]; then
  echo "export PDFTOOLS_BIN_DIR=\"$T/root/usr/bin\""
  echo "export LD_LIBRARY_PATH=\"$T/root/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
  echo "export TESSDATA_PREFIX=\"$TESSDATA\""
fi
echo "export VERAPDF_BIN=\"$V/app/verapdf\""
