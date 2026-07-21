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

# 0. Resolve the user the agent will RUN as (the installer itself must be root).
#    Captured from \$SUDO_USER so the operator who ran \`sudo bash install.sh\`
#    owns the cert/state and can inspect the agent without sudo. Falls back to
#    root when run as actual root (no SUDO_USER) — the agent only needs an
#    outbound mTLS connection, so it doesn't require root.
SVC_USER="root"
SVC_GROUP="root"
if [ -n "\${SUDO_USER:-}" ] && [ "\${SUDO_USER}" != "root" ] && id "\${SUDO_USER}" >/dev/null 2>&1; then
  SVC_USER="\${SUDO_USER}"
  SVC_GROUP="$(id -gn "\${SUDO_USER}")"
fi
log "agent will run as '$SVC_USER'"

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
    # A fresh boot usually has apt-daily/unattended-upgrades holding the dpkg
    # lock. Make EVERY apt call in this script (and the NodeSource sub-installer)
    # WAIT for the lock instead of failing instantly. Without this, the later
    # GStreamer install (step 8) loses the race, hits its '|| log WARN' guard, and
    # the device ends up provisioned-but-unable-to-stream. 600s is well past any
    # boot-time apt job; honored from apt.conf.d by every apt-get invocation.
    install -d -m 0755 /etc/apt/apt.conf.d
    echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/99xorgate-lock-timeout
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

# 1b. IMU (BNO085) tooling — best-effort so a device without the sensor (or a
#     non-Pi host) still installs cleanly. i2cdetect + the Adafruit CircuitPython
#     stack back the agent's real IMU collector (src/hardware/imu.ts); the agent
#     spawns bare \`python3\`, so the libs go system-wide. The IMU collector
#     self-gates when none of this is present, so failures here only disable IMU.
log "installing IMU tooling (i2c-tools, adafruit-circuitpython-bno08x)"
case "\${ID:-}\${ID_LIKE:-}" in
  *debian*|*ubuntu*)
    apt-get install -y -qq i2c-tools python3-pip python3-dev \\
      || log "WARN: i2c-tools/python3 pip install failed; IMU disabled"
    # PEP 668 (Bookworm+) blocks system-wide pip installs without an override;
    # older pip lacks the flag, so try with it and fall back to a plain install.
    python3 -m pip install --break-system-packages -q \\
        adafruit-circuitpython-bno08x adafruit-blinka 2>/dev/null \\
      || python3 -m pip install -q adafruit-circuitpython-bno08x adafruit-blinka \\
      || log "WARN: adafruit python libs failed to install; IMU disabled until installed"
    ;;
esac

# Enable the I2C bus and let the (non-root) agent user reach /dev/i2c-*.
if command -v raspi-config >/dev/null 2>&1; then
  raspi-config nonint do_i2c 0 || log "WARN: 'raspi-config do_i2c' failed; enable I2C manually"
else
  modprobe i2c-dev 2>/dev/null || true
fi
if getent group i2c >/dev/null 2>&1 && [ "$SVC_USER" != "root" ]; then
  usermod -aG i2c "$SVC_USER" || log "WARN: could not add $SVC_USER to the i2c group"
fi

# 2. Claim the registration code. The serial is a stable host identifier so a
#    re-run on the same machine maps to the same device (the backend rejects a
#    duplicate serial in the workspace). machine-id is preferred; fall back to the
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

# 3. Drop certs + agent.env into /etc/xorgate. Mode 0600, owned by the service
#    user (not root) so the non-root agent can read them and they stay private
#    to that user.
install -d -m 0700 -o "$SVC_USER" -g "$SVC_GROUP" "$CONF_DIR"

echo "$CLAIM_RESPONSE" | jq -r '.certPem'     \\
  | install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/device.cert.pem"
echo "$CLAIM_RESPONSE" | jq -r '.privateKey'  \\
  | install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/device.key.pem"

# The Amazon Root CA is public; fetch it by URL rather than embedding a copy.
if [ -n "$CA_URL" ]; then
  curl -fsSL --retry 3 --retry-delay 2 "$CA_URL" \\
    | install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/root-ca.pem"
else
  curl -fsSL --retry 3 --retry-delay 2 \\
    https://www.amazontrust.com/repository/AmazonRootCA1.pem \\
    | install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/root-ca.pem"
fi

install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/agent.env" <<EOF
DEVICE_ID=$DEVICE_ID
IOT_DATA_ENDPOINT=$ENDPOINT
CERT_PATH=$CONF_DIR/device.cert.pem
KEY_PATH=$CONF_DIR/device.key.pem
CA_PATH=$CONF_DIR/root-ca.pem
MODE=real
# KVS WebRTC media runtime (supervised by the agent's media collector; it reuses
# the IoT cert above for KVS creds — channels/endpoints live in kvs.json). Off
# until the operator runs \`xorgate set media on\`.
KVS_RUNTIME_BIN=$INSTALL_PREFIX/media/xorgate-kvs-webrtc
KVS_RUNTIME_LIB_DIR=$INSTALL_PREFIX/media/lib
KVS_MANIFEST=$CONF_DIR/kvs.json
# Per-stream GStreamer pipelines: drop <streamKey>.gst here (e.g. cam0.gst), or
# manage them with \`xorgate pipeline set <streamKey> <file>\`.
KVS_PIPELINE_DIR=$CONF_DIR/pipelines
# Where \`xorgate update\` pulls new builds from.
DEVICE_DIST_BUCKET_URL=$DIST_BUCKET_URL
DEVICE_DIST_VERSION=$DIST_VERSION
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

# 5b. Install the \`xorgate\` CLI as a thin wrapper that defaults XORGATE_HOME to
#     the systemd agent's state dir, so \`xorgate status\`/\`monitor\` reflect the
#     running service (no sudo needed when the agent runs as you — see the
#     drop-in below). Use systemctl/journalctl for lifecycle — \`xorgate start\`
#     would launch a SECOND worker that fights the systemd one for the IoT clientId.
# rm first: \`cat >\` follows an existing symlink and would clobber its target
# (e.g. a prior \`xorgate -> dist/cli.js\` symlink).
rm -f /usr/local/bin/xorgate
cat > /usr/local/bin/xorgate <<'WRAP'
#!/usr/bin/env bash
exec env XORGATE_HOME="\${XORGATE_HOME:-/var/lib/xorgate}" node /opt/xorgate/dist/cli.js "$@"
WRAP
chmod +x /usr/local/bin/xorgate

# 6. systemd.
install -m 0644 "$INSTALL_PREFIX/systemd/xorgate-agent.service" "$UNIT_DEST"

# Run the service as the provisioning user via a drop-in (keeps the shipped unit
# generic). StateDirectory=xorgate then makes systemd create/own /var/lib/xorgate
# as this user, so its pidfile + state are readable without sudo. systemd reads
# EnvironmentFile + sets up StateDirectory as root before dropping privileges.
install -d -m 0755 "$UNIT_DEST.d"
cat > "$UNIT_DEST.d/10-user.conf" <<EOF
[Service]
User=$SVC_USER
Group=$SVC_GROUP
EOF

# Let the agent run the two privileged actions the cloud can trigger, and only
# those. Without this the reboot/power-off commands depend on the distro's
# stock \`010_pi-nopasswd\` (NOPASSWD: ALL for the \`pi\` user), which grants far
# more than we need and is absent entirely when provisioning as any other user.
# validate before install: a malformed sudoers file locks out sudo machine-wide.
SUDOERS_TMP="\$(mktemp)"
cat > "\$SUDOERS_TMP" <<EOF
# Installed by xorgate. Allows the agent (running as $SVC_USER) to act on
# cloud-issued reboot / power-off commands. See device-agent src/agent/commands.ts.
$SVC_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff
EOF
if visudo -cf "\$SUDOERS_TMP" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "\$SUDOERS_TMP" /etc/sudoers.d/020_xorgate-power
else
  log "WARN: sudoers drop-in failed validation; reboot/power-off commands will not work"
fi
rm -f "\$SUDOERS_TMP"

systemctl daemon-reload
systemctl enable --now xorgate-agent

# 7. SIM7600 LTE connection manager (cellular uplink + GPS NMEA source).
#    Best-effort and self-gating like the IMU step (1b): a device without the
#    modem still installs cleanly. The daemon owns the modem AT port, brings up
#    the cellular link, and publishes signal telemetry the agent's \`lte\`
#    collector reads (/run/sim7600-lte/telemetry.json); it also enables GNSS so
#    the agent's \`gps\` collector can read NMEA on /dev/ttyUSB1.
log "installing SIM7600 connection manager (LTE + GPS)"
case "\${ID:-}\${ID_LIKE:-}" in
  *debian*|*ubuntu*)
    apt-get install -y -qq isc-dhcp-client usbutils \\
      || log "WARN: isc-dhcp-client/usbutils install failed; LTE may not come up"
    ;;
esac

# ModemManager claims the AT port and fights the daemon for it — disable it.
systemctl disable --now ModemManager.service 2>/dev/null || true

# The agent reads NMEA on /dev/ttyUSB1; the non-root agent user needs 'dialout'.
if getent group dialout >/dev/null 2>&1 && [ "$SVC_USER" != "root" ]; then
  usermod -aG dialout "$SVC_USER" || log "WARN: could not add $SVC_USER to the dialout group"
fi

# Install the daemon + its systemd unit + udev rule from the extracted tarball.
if [ -f "$INSTALL_PREFIX/modem/sim7600-lte.sh" ]; then
  install -m 0755 "$INSTALL_PREFIX/modem/sim7600-lte.sh" /usr/local/bin/sim7600-lte.sh
  install -m 0644 "$INSTALL_PREFIX/modem/sim7600-lte.service" /etc/systemd/system/sim7600-lte.service
  install -m 0644 "$INSTALL_PREFIX/modem/99-sim7600-lte.rules" /etc/udev/rules.d/99-sim7600-lte.rules
  udevadm control --reload-rules 2>/dev/null || true
  # usb0 is owned exclusively by the sim7600-lte daemon (its own dhclient +
  # end-to-end health checks). NetworkManager must not manage it, or it races
  # the daemon for the modem's internal DHCP lease and leaves stale duplicate
  # addresses that wedge reconnection after an LTE outage.
  if [ -f "$INSTALL_PREFIX/modem/99-sim7600-unmanaged.conf" ]; then
    install -d -m 0755 /etc/NetworkManager/conf.d
    install -m 0644 "$INSTALL_PREFIX/modem/99-sim7600-unmanaged.conf" /etc/NetworkManager/conf.d/99-sim7600-unmanaged.conf
    systemctl reload NetworkManager 2>/dev/null || true
  fi
  systemctl daemon-reload
  # Enable so it persists + starts now if the modem is already enumerated; the
  # udev rule also starts it on hotplug. Failure here only disables LTE/GPS.
  systemctl enable --now sim7600-lte.service 2>/dev/null \\
    || systemctl enable sim7600-lte.service 2>/dev/null \\
    || log "WARN: could not enable sim7600-lte.service; LTE/GPS disabled"
else
  log "WARN: modem assets missing from build ($INSTALL_PREFIX/modem); LTE/GPS disabled"
fi

# 7b. Uplink priority: prefer WiFi over the LTE modem for the IPv4 default route.
#     usb0 is unmanaged by NM (see 7); the sim7600-lte daemon installs the LTE
#     default route itself at metric 100. Dropping WiFi's metric to 50 makes WiFi
#     win whenever it is associated, with LTE as the fallback (used only when
#     WiFi is down/absent). Without this, a dead-but-up LTE link (antenna out /
#     no signal, USB net iface still up) could win the route and black-hole
#     IPv4 — including KVS WebRTC video, whose endpoints are IPv4-only.
#     Best-effort and self-gating: only applied when NetworkManager is the
#     active stack. The SIM7600 manager is unaffected — its health checks
#     bind to usb0 directly (ping -I usb0), independent of the default route.
#     NOTE: this is link-based, not connectivity-based; it assumes the device only
#     joins trusted WiFi that has real internet (a captive/dead AP would black-hole).
if command -v nmcli >/dev/null 2>&1 && systemctl is-active --quiet NetworkManager 2>/dev/null; then
  log "setting WiFi to outrank the LTE modem for the IPv4 default route"
  install -d -m 0755 /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/10-uplink-priority.conf <<'NMEOF'
# Prefer WiFi over the LTE modem (usb0) for the IPv4 default route.
# WiFi connections get route-metric 50; usb0 is unmanaged by NM and the
# sim7600-lte daemon installs its default route at metric 100, so WiFi wins
# whenever it is associated. LTE stays the fallback, used only when WiFi is
# down or absent. Interface-bound health checks in the SIM7600 manager
# (ping -I usb0) are unaffected by this.
[connection-wifi-priority]
match-device=type:wifi
ipv4.route-metric=50
NMEOF
  systemctl reload NetworkManager 2>/dev/null || true
else
  log "NOTE: NetworkManager not active; skipping WiFi/LTE route-priority config"
fi

# 8. KVS WebRTC media runtime — deps + manifest. Best-effort and self-gating like
#    the IMU (1b) and SIM7600 (7) steps: a device that won't stream still installs
#    cleanly. The aarch64 \`xorgate-kvs-webrtc\` binary ships in the tarball under
#    media/; its KVS SDK .so libs are supplied separately into media/lib. The media
#    collector stays inert until enabled (\`xorgate set media on\`) and the libs land.
log "installing KVS WebRTC media runtime deps"
case "\${ID:-}\${ID_LIKE:-}" in
  *debian*|*ubuntu*)
    # apt-provided runtime libs the binary links + the GStreamer elements its
    # pipeline needs at runtime (videotestsrc from -base, x264enc from -ugly,
    # libcamerasrc from -libcamera). glib + its deps (libffi, pcre2, …) and the
    # gst base/app libs come in transitively with these.
    apt-get install -y -qq \\
        libglib2.0-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \\
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good \\
        gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-tools \\
      || log "WARN: GStreamer runtime install failed; media streaming disabled. Re-run: sudo apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly"
    # libcamera source (Raspberry Pi cameras); absent on some distros — ignore.
    apt-get install -y -qq gstreamer1.0-libcamera 2>/dev/null || true
    # NOTE: the rest are NOT apt packages — the KVS SDK libs, its vendored
    # OpenSSL 1.1 (libssl/libcrypto.so.1.1, which differ from the system
    # OpenSSL 3 on current Pi OS), and libwebsockets ship in the bundle at
    # $INSTALL_PREFIX/media/lib and are found via LD_LIBRARY_PATH.
    ;;
esac

# Write the KVS manifest the media collector reads — region, IoT credential
# endpoint, role alias, and per-channel names, all straight from the claim
# response. Mode 0600, owned by the service user (matches the cert files).
echo "$CLAIM_RESPONSE" \\
  | jq '{deviceId, region, credentialEndpoint, roleAlias, channels: (.channels // []), uploadBucket}' \\
  | install -m 0600 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/kvs.json"

# Per-stream pipeline dir (operator drops <streamKey>.gst files here for cameras).
install -d -m 0755 -o "$SVC_USER" -g "$SVC_GROUP" "$CONF_DIR/pipelines"

# Default per-stream pipelines for the current fleet hardware: CM5 carrier with
# two IMX290 sensors on the cam0 (i2c@88000) and cam1 (i2c@70000) connectors,
# H.264 via x264enc at 1280x720@15. Written only if absent so a later
# \`xorgate pipeline set\` customization is never clobbered. Hardware-specific by
# design (pairs with the imx290 overlays in step 8b) — revisit for other sensors.
if [ ! -f "$CONF_DIR/pipelines/cam0.gst" ]; then
  install -m 0644 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/pipelines/cam0.gst" <<'GST'
libcamerasrc name=cam0 camera-name=/base/axi/pcie@1000120000/rp1/i2c@88000/imx290@1a ! video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! x264enc bframes=0 speed-preset=ultrafast bitrate=1000 byte-stream=TRUE tune=zerolatency threads=2 ! video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! appsink sync=TRUE emit-signals=TRUE name=appsink-video
GST
fi
if [ ! -f "$CONF_DIR/pipelines/cam1.gst" ]; then
  install -m 0644 -o "$SVC_USER" -g "$SVC_GROUP" /dev/stdin "$CONF_DIR/pipelines/cam1.gst" <<'GST'
libcamerasrc name=cam1 camera-name=/base/axi/pcie@1000120000/rp1/i2c@70000/imx290@1a ! video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! x264enc bframes=0 speed-preset=ultrafast bitrate=1000 byte-stream=TRUE tune=zerolatency threads=2 ! video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! appsink sync=TRUE emit-signals=TRUE name=appsink-video
GST
fi

# Stage the runtime binary (tar preserves the +x bit, but be defensive) and warn
# if the user-supplied KVS SDK .so libs aren't present yet.
if [ -f "$INSTALL_PREFIX/media/xorgate-kvs-webrtc" ]; then
  chmod 0755 "$INSTALL_PREFIX/media/xorgate-kvs-webrtc" || true
  log "media runtime staged; enable streaming with: xorgate set media on"
  if ! ls "$INSTALL_PREFIX"/media/lib/*.so* >/dev/null 2>&1; then
    log "NOTE: KVS SDK .so libs missing in $INSTALL_PREFIX/media/lib; supply them to enable streaming"
  fi
else
  log "WARN: media runtime binary missing from build ($INSTALL_PREFIX/media); streaming disabled"
fi

# 8b. Camera device-tree overlays for the current fleet hardware (CM5 + dual
#     IMX290 on the cam0/cam1 connectors). IMX290 has no camera EEPROM, so
#     camera_auto_detect never finds it; the sensors only bind with explicit
#     overlays. Idempotent + backed up + best-effort. Hardware-specific by design
#     (pairs with the default pipelines above). Takes effect on the NEXT BOOT, so
#     a fresh device needs one reboot after install before streaming works.
CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt
if [ -f "$CONFIG_TXT" ]; then
  cp -n "$CONFIG_TXT" "$CONFIG_TXT.bak-xorgate" 2>/dev/null || true
  CAM_OVERLAY_ADDED=0
  if grep -qE '^camera_auto_detect=' "$CONFIG_TXT"; then
    sed -i 's/^camera_auto_detect=.*/camera_auto_detect=0/' "$CONFIG_TXT"
  else
    echo 'camera_auto_detect=0' >> "$CONFIG_TXT"
  fi
  grep -qE '^dtoverlay=imx290,cam0' "$CONFIG_TXT" || { echo 'dtoverlay=imx290,cam0' >> "$CONFIG_TXT"; CAM_OVERLAY_ADDED=1; }
  grep -qE '^dtoverlay=imx290,cam1' "$CONFIG_TXT" || { echo 'dtoverlay=imx290,cam1' >> "$CONFIG_TXT"; CAM_OVERLAY_ADDED=1; }
  if [ "$CAM_OVERLAY_ADDED" = "1" ]; then
    log "camera overlays (dual IMX290) added to $CONFIG_TXT — REBOOT required before cameras stream"
  else
    log "camera overlays already present in $CONFIG_TXT"
  fi
else
  log "WARN: no config.txt found; skipping camera overlays"
fi

log "registered device $DEVICE_ID"
log "tail logs: sudo journalctl -u xorgate-agent -f"
`;
