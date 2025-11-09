#!/usr/bin/env bash
set -uo pipefail

ROOT="${1:-.}"
BIN_DIR="$ROOT/bin"

# Farben
RED="$(tput setaf 1 || true)"
GRN="$(tput setaf 2 || true)"
YEL="$(tput setaf 3 || true)"
BLU="$(tput setaf 4 || true)"
RST="$(tput sgr0 || true)"

need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "${RED}Fehlendes Tool: $1${RST}"
    echo "Bitte installieren: sudo apt-get update && sudo apt-get install -y $1"
    exit 2
  fi
}

need_tool jq
need_tool curl
need_tool find
need_tool sed

if [[ ! -d "$BIN_DIR" ]]; then
  echo "${RED}Verzeichnis nicht gefunden: $BIN_DIR${RST}"
  exit 1
fi

total_manifests=0
invalid_json=0
total_urls=0
ok_count=0
notfound_404=0
other_err=0

normalize_url() {
  local u="$1"
  # Proxy-Prefix entfernen
  u="${u#https://proxy.corsfix.com/?}"
  echo "$u"
}

check_url() {
  local url="$1"
  # Erst HEAD mit Redirects
  local code
  code="$(curl -s -o /dev/null -IL --max-time 25 "$url" -w '%{http_code}' || echo "0")"

  # Manche Server blocken HEAD (405/403) -> mit Range-GET probieren
  if [[ "$code" == "405" || "$code" == "403" || "$code" == "0" ]]; then
    code="$(curl -s -o /dev/null -L --max-time 30 --range 0-0 "$url" -w '%{http_code}' || echo "0")"
  fi

  echo "$code"
}

print_status() {
  local code="$1"
  if [[ "$code" =~ ^2[0-9]{2}$ ]]; then
    echo "[${GRN}OK${RST}]"
  elif [[ "$code" == "404" ]]; then
    echo "[${RED}404${RST}]"
  elif [[ "$code" == "0" ]]; then
    echo "[${RED}ERR: Timeout/Netz${RST}]"
  else
    echo "[${YEL}$code${RST}]"
  fi
}

echo "${BLU}Suche Manifeste unter:${RST} $BIN_DIR"
echo

# Alle manifest*.json Dateien
while IFS= read -r -d '' mf; do
  ((total_manifests++)) || true
  rel_path="${mf#$ROOT/}"

  # JSON validieren
  if ! jq -e . "$mf" >/dev/null 2>&1; then
    echo "${RED}Ungültiges JSON:${RST} $rel_path"
    ((invalid_json++)) || true
    echo
    continue
  fi

  echo "${BLU}Manifest:${RST} $rel_path"

  # Alle Stringwerte herausziehen, die mit http/https beginnen
  mapfile -t urls < <(jq -r '
    paths(scalars) as $p
    | getpath($p)
    | select(type=="string" and test("^https?://"))
  ' "$mf" | sort -u)

  if [[ ${#urls[@]} -eq 0 ]]; then
    echo "  Keine HTTP/HTTPS-Links gefunden."
    echo
    continue
  fi

  for url in "${urls[@]}"; do
    ((total_urls++)) || true

    clean_url="$(normalize_url "$url")"
    code="$(check_url "$clean_url")"
    status="$(print_status "$code")"
    echo "  $status $clean_url"

    if [[ "$code" =~ ^2[0-9]{2}$ ]]; then
      ((ok_count++)) || true
    elif [[ "$code" == "404" ]]; then
      ((notfound_404++)) || true
    else
      ((other_err++)) || true
    fi
  done

  echo
done < <(find "$BIN_DIR" -type f -name 'manifest*.json' -print0 | sort -z)

echo "=============== Zusammenfassung ==============="
echo "Manifeste gesamt:     $total_manifests"
echo "Ungültige JSON:       $invalid_json"
echo "Gefundene Links:      $total_urls"
echo "OK (2xx):             $ok_count"
echo "404:                  $notfound_404"
echo "Andere Fehler:        $other_err"

# Exit-Code ungleich 0, falls Fehler gefunden wurden
if (( invalid_json > 0 || notfound_404 > 0 || other_err > 0 )); then
  exit 1
fi
exit 0