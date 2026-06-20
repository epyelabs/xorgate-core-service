// install.sh template served by GET /get/:code. Substitution is done at
// request time in the Lambda (not at deploy time) so one Lambda build serves
// every code.
//
// Placeholders use distinctive __SCREAMING_SNAKE__ form so a stray substring
// in the script body can never accidentally match. All four placeholders are
// required; the handler does a sanity check after substitution to confirm
// none remain.

export const INSTALL_SCRIPT_PLACEHOLDERS = [
  '__REG_CODE__',
  '__API_BASE__',
  '__DIST_BUCKET_URL__',
  '__DIST_VERSION__',
] as const;

export interface InstallScriptVars {
  regCode: string;
  apiBase: string;
  distBucketUrl: string;
  distVersion: string;
}

export function renderInstallScript(vars: InstallScriptVars): string {
  return INSTALL_SCRIPT_TEMPLATE.replaceAll('__REG_CODE__', vars.regCode)
    .replaceAll('__API_BASE__', vars.apiBase)
    .replaceAll('__DIST_BUCKET_URL__', vars.distBucketUrl)
    .replaceAll('__DIST_VERSION__', vars.distVersion);
}

const INSTALL_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# xorgate device install script.
# Generated per-request by GET /get/:code. Do not edit by hand on the host.
set -euo pipefail

REG_CODE='__REG_CODE__'
API_BASE='__API_BASE__'
DIST_BUCKET_URL='__DIST_BUCKET_URL__'
DIST_VERSION='__DIST_VERSION__'

CONF_DIR=/etc/xorgate
INSTALL_PREFIX=/opt/xorgate
UNIT_DEST=/etc/systemd/system/xorgate-agent.service

log()  { echo "[xorgate] $*"; }
fail() { echo "[xorgate] ERROR: $*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "run with sudo"
fi

# 1. Distro detection + dependency install.
if [ -r /etc/os-release ]; then
  . /etc/os-release
else
  fail "cannot read /etc/os-release (unsupported distro)"
fi

case "\${ID:-}\${ID_LIKE:-}" in
  *debian*|*ubuntu*)
    log "installing apt dependencies"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates jq build-essential python3
    if ! command -v node >/dev/null 2>&1 \\
       || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
      log "installing Node.js 20 via NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
    fi
    ;;
  *)
    fail "unsupported distro (\${ID:-unknown}); only Debian/Ubuntu supported"
    ;;
esac

# 2. Claim the registration code. The serial is a stable host identifier so a
#    re-run on the same machine maps to the same device (the backend rejects a
#    duplicate serial in the project). machine-id is preferred; fall back to the
#    DMI product UUID, then the hostname.
HOSTNAME_VAL=$(hostname || echo unknown)
PLATFORM_VAL=$(uname -m || echo unknown)
SERIAL_VAL=$(cat /etc/machine-id 2>/dev/null \\
  || cat /sys/class/dmi/id/product_uuid 2>/dev/null \\
  || echo "$HOSTNAME_VAL")

log "claiming registration code via $API_BASE"
CLAIM_RESPONSE=$(curl -fsSL --retry 3 --retry-delay 2 \\
  -X POST -H 'Content-Type: application/json' \\
  -d "$(jq -n --arg s "$SERIAL_VAL" --arg h "$HOSTNAME_VAL" --arg p "$PLATFORM_VAL" \\
        '{serial:$s, hostname:$h, platform:$p}')" \\
  "$API_BASE/device-registrations/$REG_CODE/claim") \\
  || fail "claim failed (code may be expired, already used, or the device already registered)"

DEVICE_ID=$(echo "$CLAIM_RESPONSE"   | jq -r '.deviceId // empty')
ENDPOINT=$(echo "$CLAIM_RESPONSE"    | jq -r '.dataEndpoint // empty')
CA_URL=$(echo "$CLAIM_RESPONSE"      | jq -r '.caUrl // empty')

[ -n "$DEVICE_ID" ] || fail "claim response missing deviceId"
[ -n "$ENDPOINT" ]  || fail "claim response missing dataEndpoint"

# 3. Drop certs + agent.env into /etc/xorgate. Mode 0600 root:root since the
#    agent runs as root.
install -d -m 0700 -o root -g root "$CONF_DIR"

echo "$CLAIM_RESPONSE" | jq -r '.certPem'     \\
  | install -m 0600 -o root -g root /dev/stdin "$CONF_DIR/device.cert.pem"
echo "$CLAIM_RESPONSE" | jq -r '.privateKey'  \\
  | install -m 0600 -o root -g root /dev/stdin "$CONF_DIR/device.key.pem"

# The Amazon Root CA is public; fetch it by URL rather than embedding a copy.
if [ -n "$CA_URL" ]; then
  curl -fsSL --retry 3 --retry-delay 2 "$CA_URL" \\
    | install -m 0600 -o root -g root /dev/stdin "$CONF_DIR/root-ca.pem"
else
  curl -fsSL --retry 3 --retry-delay 2 \\
    https://www.amazontrust.com/repository/AmazonRootCA1.pem \\
    | install -m 0600 -o root -g root /dev/stdin "$CONF_DIR/root-ca.pem"
fi

install -m 0600 -o root -g root /dev/stdin "$CONF_DIR/agent.env" <<EOF
DEVICE_ID=$DEVICE_ID
IOT_DATA_ENDPOINT=$ENDPOINT
CERT_PATH=$CONF_DIR/device.cert.pem
KEY_PATH=$CONF_DIR/device.key.pem
CA_PATH=$CONF_DIR/root-ca.pem
MODE=sim
EOF

# 4. Fetch + extract the device tarball.
TARBALL="xorgate-agent-$DIST_VERSION.tar.gz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log "downloading $DIST_BUCKET_URL/$TARBALL"
curl -fsSL --retry 3 --retry-delay 2 "$DIST_BUCKET_URL/$TARBALL" -o "$TMP/$TARBALL"

install -d -m 0755 "$INSTALL_PREFIX"
tar -xzf "$TMP/$TARBALL" -C "$INSTALL_PREFIX"

# 5. Install runtime node modules for the target arch. Files stay root-owned
#    (the agent runs as root); no chown needed.
log "installing node modules in $INSTALL_PREFIX"
(cd "$INSTALL_PREFIX" && npm ci --omit=dev --no-audit --no-fund)

# 6. systemd.
install -m 0644 "$INSTALL_PREFIX/systemd/xorgate-agent.service" "$UNIT_DEST"
systemctl daemon-reload
systemctl enable --now xorgate-agent

log "registered device $DEVICE_ID"
log "tail logs: sudo journalctl -u xorgate-agent -f"
`;
