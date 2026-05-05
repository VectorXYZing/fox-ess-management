#!/usr/bin/env bash
# Fox ESS Management — interactive first-time setup
# Run: bash setup.sh
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  GRN='\033[0;32m'; AMB='\033[0;33m'; BLU='\033[0;34m'
  BOLD='\033[1m'; DIM='\033[2m'; RST='\033[0m'
else
  GRN=''; AMB=''; BLU=''; BOLD=''; DIM=''; RST=''
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
ask()         { read -rp "  $1: " _v;             echo "$_v"; }
ask_def()     { read -rp "  $1 [${2}]: " _v;      echo "${_v:-$2}"; }
ask_secret()  { read -rsp "  $1: " _v; echo ""; echo "$_v"; }

hr() { printf '%0.s─' {1..56}; echo ""; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${AMB}${BOLD}  ⚡ Fox ESS Management — Setup${RST}"
hr

# ── Pre-flight checks ─────────────────────────────────────────────────────────
HAVE_DOCKER=false; HAVE_NODE=false
command -v docker &>/dev/null && docker info &>/dev/null 2>&1 && HAVE_DOCKER=true
command -v node   &>/dev/null && HAVE_NODE=true

if ! $HAVE_DOCKER && ! $HAVE_NODE; then
  echo -e "${AMB}  Warning: neither Docker nor Node.js found.${RST}"
  echo -e "  Install one before running the dashboard."
  echo ""
fi

# ── Fox ESS credentials ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Fox ESS credentials${RST}"
echo -e "  ${DIM}API key: foxesscloud.com → User Center → API Management${RST}"
echo -e "  ${DIM}Serial:  shown on the inverter label and in the Fox app${RST}"
echo ""
FOX_API_KEY=$(ask  "Fox ESS API key")
DEVICE_SN=$(ask    "Device serial number")

# ── Location & solar ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Location & solar${RST}"
echo -e "  ${DIM}AEMO regions: VIC1 NSW1 QLD1 SA1 TAS1 (skip if outside NEM)${RST}"
echo ""
AEMO_REGION=$(ask_def "AEMO region"        "VIC1")
TIMEZONE=$(ask_def    "Timezone"           "Australia/Melbourne")
LATITUDE=$(ask_def    "Latitude"           "-33.8688")
LONGITUDE=$(ask_def   "Longitude"          "151.2093")
SYSTEM_KW=$(ask_def   "Solar system size (kW)"   "5.0")
BATTERY_KWH=$(ask_def "Battery capacity (kWh)"   "10.0")

# ── Security ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  Security${RST}"
echo -e "  ${DIM}Admin password gates all write actions (scheduler, settings).${RST}"
echo ""
while true; do
  PW=$(ask_secret "Admin password (min 8 chars)")
  [ ${#PW} -ge 8 ] && break
  echo -e "  ${AMB}  Password must be at least 8 characters.${RST}"
done

# ── Write .env ────────────────────────────────────────────────────────────────
cat > .env <<EOF
ADMIN_PASSWORD=${PW}
EOF
echo ""
echo -e "  ${GRN}✓ .env written${RST}"

# ── Write config.json ─────────────────────────────────────────────────────────
# Export values as env vars so the embedded script can read them safely
# (avoids shell-quoting issues with special chars in API keys / passwords).
export _FOX_API_KEY="$FOX_API_KEY"
export _DEVICE_SN="$DEVICE_SN"
export _AEMO_REGION="$AEMO_REGION"
export _TIMEZONE="$TIMEZONE"
export _LATITUDE="$LATITUDE"
export _LONGITUDE="$LONGITUDE"
export _SYSTEM_KW="$SYSTEM_KW"
export _BATTERY_KWH="$BATTERY_KWH"

WRITE_CONFIG='
import json, os, sys
with open("config.example.json") as f:
    cfg = json.load(f)
cfg["foxApiKey"]          = os.environ["_FOX_API_KEY"]
cfg["deviceSN"]           = os.environ["_DEVICE_SN"]
cfg["aemoRegion"]         = os.environ["_AEMO_REGION"]
cfg["timezone"]           = os.environ["_TIMEZONE"]
cfg["solar"]["latitude"]  = float(os.environ["_LATITUDE"]  or 0)
cfg["solar"]["longitude"] = float(os.environ["_LONGITUDE"] or 0)
cfg["solar"]["systemKw"]  = float(os.environ["_SYSTEM_KW"]  or 5)
cfg["battery"]["capacityKwh"] = float(os.environ["_BATTERY_KWH"] or 10)
with open("config.json", "w") as f:
    json.dump(cfg, f, indent=2)
print("  config.json written")
'

if command -v python3 &>/dev/null; then
  python3 -c "$WRITE_CONFIG"
elif command -v node &>/dev/null; then
  node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
cfg.foxApiKey             = process.env._FOX_API_KEY;
cfg.deviceSN              = process.env._DEVICE_SN;
cfg.aemoRegion            = process.env._AEMO_REGION;
cfg.timezone              = process.env._TIMEZONE;
cfg.solar.latitude        = parseFloat(process.env._LATITUDE)  || 0;
cfg.solar.longitude       = parseFloat(process.env._LONGITUDE) || 0;
cfg.solar.systemKw        = parseFloat(process.env._SYSTEM_KW)  || 5;
cfg.battery.capacityKwh   = parseFloat(process.env._BATTERY_KWH) || 10;
fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2));
console.log('  config.json written');
"
else
  echo -e "  ${AMB}Warning: python3 and node not found — config.json not written.${RST}"
  echo "  Copy config.example.json to config.json and edit it manually."
fi

echo -e "  ${GRN}✓ config.json written${RST}"

# ── Start ─────────────────────────────────────────────────────────────────────
echo ""
hr
echo ""
if $HAVE_DOCKER; then
  read -rp "  Start the dashboard now with Docker? [Y/n]: " _start
  _start="${_start:-Y}"
  if [[ "$_start" =~ ^[Yy] ]]; then
    echo ""
    docker compose up -d
    echo ""
    echo -e "  ${GRN}${BOLD}✓ Dashboard running!${RST}"
    echo -e "  Open ${BLU}http://localhost:8080${RST} in your browser."
  else
    echo "  To start later:  docker compose up -d"
  fi
elif $HAVE_NODE; then
  echo -e "  To start:  ${BLU}ADMIN_PASSWORD=\$(grep ADMIN_PASSWORD .env | cut -d= -f2) node proxy.js${RST}"
fi
echo ""
