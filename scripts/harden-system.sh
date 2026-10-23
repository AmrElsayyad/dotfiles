#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Lynis-inspired Hardening Script
#
# Normal run:
#   sudo ./harden-system.sh --yes
#
# Also disable SSH (destructive; run only from a local console):
#   sudo DISABLE_SSH=1 ./harden-system.sh --yes
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { printf '%b\n' "${GREEN}[OK]${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}[WARN]${NC} $*"; }
fail() { printf '%b\n' "${RED}[FAIL]${NC} $*"; }

if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root: sudo ./harden-system.sh --yes"
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  fail "Refusing to run without confirmation."
  echo "Review this script first, then run: sudo $0 --yes" >&2
  exit 2
fi

if [[ -n "${SSH_CONNECTION:-}${SSH_TTY:-}${SSH_CLIENT:-}" ]]; then
  fail "Active SSH session detected."
  echo "Run this script from a local console, not over SSH." >&2
  exit 3
fi

BACKUP_DIR="/var/backups/harden-system/$(date +%Y%m%d-%H%M%S)"
ROLLBACK="$BACKUP_DIR/rollback.sh"
RUN_LOG="$BACKUP_DIR/run.log"
FAILED=0

mkdir -p "$BACKUP_DIR/files"
touch "$RUN_LOG"
chmod 700 "$BACKUP_DIR"

printf '#!/usr/bin/env bash\nset -euo pipefail\n' >"$ROLLBACK"
chmod 700 "$ROLLBACK"

# Record a rollback command.
rollback() {
  printf '%b\n' "$*" >>"$ROLLBACK"
}

# Back up a file or directory once per run.
declare -A BACKED_UP=()
backup_path() {
  local src=$1
  local dest

  [[ -n "${BACKED_UP[$src]:-}" ]] && return 0
  BACKED_UP[$src]=1

  dest="$BACKUP_DIR/files/$(printf '%s' "${src#/}" | tr '/' '_')"

  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
    rollback "cp -a -- %q %q" "$dest" "$src"
  else
    rollback "rm -f -- %q" "$src"
  fi
}

# Record a path's current numeric mode before changing it.
backup_mode() {
  local path=$1
  local mode

  [[ -e "$path" ]] || return 0

  mode=$(stat -c '%a' "$path")
  rollback "chmod %q -- %q" "$mode" "$path"
}

# Record enough systemd state to restore a unit later.
backup_systemd_state() {
  local unit=$1

  if systemctl is-enabled "$unit" >/dev/null 2>&1; then
    rollback "systemctl enable --now %q >/dev/null 2>&1 || true" "$unit"
  else
    rollback "systemctl disable %q >/dev/null 2>&1 || true" "$unit"
  fi

  if systemctl is-active "$unit" >/dev/null 2>&1; then
    rollback "systemctl start %q >/dev/null 2>&1 || true" "$unit"
  fi

  rollback "systemctl unmask %q >/dev/null 2>&1 || true" "$unit"
}

# Run a command, log output, and count real failures.
run() {
  local desc=$1
  shift

  echo "→ $desc" | tee -a "$RUN_LOG"

  if "$@" >>"$RUN_LOG" 2>&1; then
    ok "$desc"
  else
    fail "$desc (see $RUN_LOG)"
    FAILED=$((FAILED + 1))
  fi
}

# Run a verification command.
check() {
  local desc=$1
  shift

  if "$@" >/dev/null 2>&1; then
    ok "$desc"
  else
    fail "$desc"
    FAILED=$((FAILED + 1))
  fi
}

# Trim leading and trailing whitespace.
trim() {
  local value=$1
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

echo "============================================================"
echo "  Lynis-inspired Hardening Script"
echo "  Backup directory: $BACKUP_DIR"
echo "============================================================"
echo

# ─────────────────────────────────────────────────────────────
# 1. Refresh package lists and apply updates
# ─────────────────────────────────────────────────────────────
echo "--- [1/14] Refresh package lists and apply updates ---"

run "Package lists refreshed" apt-get update -qq

if apt list --upgradable 2>/dev/null | grep -q upgradable; then
  run "Package updates applied" apt-get -y -qq upgrade
else
  ok "System is up-to-date"
fi

# ─────────────────────────────────────────────────────────────
# 2. Purge configuration from removed packages
# ─────────────────────────────────────────────────────────────
echo
echo "--- [2/14] Remove orphaned package configuration ---"

if dpkg -l 2>/dev/null | grep -q '^rc'; then
  mapfile -t ORPHANS < <(dpkg -l | awk '/^rc/ {print $2}')
  run "Purged ${#ORPHANS[@]} orphaned package configuration(s)" \
    dpkg --purge "${ORPHANS[@]}"
else
  ok "No orphaned package configuration found"
fi

# ─────────────────────────────────────────────────────────────
# 3. Remove automatically unneeded packages
# ─────────────────────────────────────────────────────────────
echo
echo "--- [3/14] Remove unused packages ---"

run "Removed unused packages" apt-get autoremove --purge -y -qq

# ─────────────────────────────────────────────────────────────
# 4. Kernel sysctl hardening
# ─────────────────────────────────────────────────────────────
echo
echo "--- [4/14] Kernel sysctl hardening ---"

backup_path /etc/sysctl.d/99-hardening.conf

cat >/etc/sysctl.d/99-hardening.conf <<'SYSCTL_EOF'
# Lynis-inspired kernel hardening.
# unprivileged_bpf_disabled=2 disables unprivileged BPF but remains
# administratively changeable; value 1 is irreversible until reboot.
fs.protected_fifos = 2
fs.suid_dumpable = 0
kernel.core_uses_pid = 1
kernel.kptr_restrict = 2
kernel.perf_event_paranoid = 3
kernel.sysrq = 0
kernel.unprivileged_bpf_disabled = 2
net.core.bpf_jit_harden = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.forwarding = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.log_martians = 1
SYSCTL_EOF

sysctl_failures=0

while IFS= read -r line || [[ -n $line ]]; do
  # Skip blank lines and comments.
  [[ -z $line || $line == \#* || $line == \;* ]] && continue

  key=$(trim "${line%%=*}")
  value=$(trim "${line#*=}")

  [[ -z $key || -z $value ]] && continue

  # A value of 1 permanently disables unprivileged BPF until reboot.
  # Do not count an attempt to change 1 to 2 as a failure.
  if [[ $key == "kernel.unprivileged_bpf_disabled" ]]; then
    current_bpf_state=$(sysctl -n kernel.unprivileged_bpf_disabled 2>/dev/null || echo unknown)

    if [[ $current_bpf_state == "1" ]]; then
      warn "Unprivileged BPF is already permanently disabled for this boot (value 1)."
      warn "Reboot to allow the configured reversible value 2 to be applied."
      continue
    fi
  fi

  if sysctl -w "$key=$value" >>"$RUN_LOG" 2>&1; then
    ok "Set $key=$value"
  else
    fail "Could not set $key=$value; see $RUN_LOG"
    sysctl_failures=$((sysctl_failures + 1))
  fi
done </etc/sysctl.d/99-hardening.conf

if ((sysctl_failures == 0)); then
  ok "All applicable sysctl settings applied"
else
  warn "$sysctl_failures sysctl setting(s) could not be applied"
  FAILED=$((FAILED + 1))
fi

# ─────────────────────────────────────────────────────────────
# 5. Disable uncommon network protocols
# ─────────────────────────────────────────────────────────────
echo
echo "--- [5/14] Disable uncommon network protocols ---"

backup_path /etc/modprobe.d/disable-protocols.conf

cat >/etc/modprobe.d/disable-protocols.conf <<'MOD_EOF'
# Disable uncommon network protocols.
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
MOD_EOF

ok "Disabled dccp, sctp, rds, and tipc at module load time"

# ─────────────────────────────────────────────────────────────
# 6. Optionally disable SSH
# ─────────────────────────────────────────────────────────────
echo
echo "--- [6/14] SSH service ---"

if [[ "${DISABLE_SSH:-0}" != "1" ]]; then
  warn "SSH disablement skipped. Set DISABLE_SSH=1 to enable this destructive step."
elif systemctl list-unit-files --no-legend ssh.service ssh.socket 2>/dev/null | grep -q .; then
  backup_systemd_state ssh.service
  backup_systemd_state ssh.socket

  run "SSH service stopped" systemctl stop ssh.service || true
  run "SSH socket stopped" systemctl stop ssh.socket || true
  run "SSH service disabled" systemctl disable ssh.service || true
  run "SSH service and socket masked" systemctl mask ssh.service ssh.socket

  warn "SSH is disabled. To restore it locally later:"
  warn "  sudo systemctl unmask ssh.service ssh.socket"
  warn "  sudo systemctl enable --now ssh.service"
else
  warn "SSH service not installed; nothing to disable"
fi

# ─────────────────────────────────────────────────────────────
# 7. Postfix banner and VRFY
# ─────────────────────────────────────────────────────────────
echo
echo "--- [7/14] Postfix hardening ---"

if command -v postconf >/dev/null 2>&1; then
  old_banner=$(postconf -h smtpd_banner 2>/dev/null || true)
  old_vrfy=$(postconf -h disable_vrfy_command 2>/dev/null || true)

  rollback "postconf -e 'smtpd_banner = %q'" \
    "${old_banner:-\$myhostname ESMTP \$mail_name}"
  rollback "postconf -e 'disable_vrfy_command = %q'" \
    "${old_vrfy:-no}"

  run "Postfix banner sanitized" \
    postconf -e 'smtpd_banner = $myhostname ESMTP'
  run "Postfix VRFY disabled" \
    postconf -e 'disable_vrfy_command = yes'
  run "Postfix restarted" systemctl restart postfix
else
  warn "Postfix not found; skipping"
fi

# ─────────────────────────────────────────────────────────────
# 8. Fail2ban local configuration
# ─────────────────────────────────────────────────────────────
echo
echo "--- [8/14] Fail2ban configuration ---"

if [[ -f /etc/fail2ban/jail.conf ]]; then
  if [[ ! -f /etc/fail2ban/jail.local ]]; then
    backup_path /etc/fail2ban/jail.local
    cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
    ok "Created /etc/fail2ban/jail.local from jail.conf"
  else
    warn "/etc/fail2ban/jail.local already exists; not overwritten"
  fi

  if systemctl list-unit-files fail2ban.service >/dev/null 2>&1; then
    run "Fail2ban restarted" systemctl restart fail2ban
  fi
else
  warn "Fail2ban not found; skipping"
fi

# ─────────────────────────────────────────────────────────────
# 9. AppArmor Firefox profile
# ─────────────────────────────────────────────────────────────
echo
echo "--- [9/14] AppArmor Firefox enforcement ---"

if ! command -v apparmor_parser >/dev/null 2>&1; then
  warn "apparmor_parser not found; install apparmor-utils to use this step"
else
  firefox_profile=""

  for candidate in \
    /etc/apparmor.d/usr.bin.firefox \
    /etc/apparmor.d/firefox; do
    if [[ -f $candidate ]]; then
      firefox_profile=$candidate
      break
    fi
  done

  if [[ -z $firefox_profile ]]; then
    warn "No Firefox AppArmor profile file found; skipping"
  elif apparmor_parser -r "$firefox_profile" >>"$RUN_LOG" 2>&1; then
    if aa-status 2>/dev/null | grep -qi firefox; then
      ok "Firefox AppArmor profile loaded"
    else
      warn "Firefox profile parsed, but no Firefox profile appears loaded"
      warn "Pop!_OS may ship a Firefox profile that is present but not loadable."
    fi
  else
    warn "Could not load Firefox AppArmor profile; see $RUN_LOG"
  fi
fi

# ─────────────────────────────────────────────────────────────
# 10. systemd-resolved DNS hardening
# ─────────────────────────────────────────────────────────────
echo
echo "--- [10/14] DNS hardening ---"

mkdir -p /etc/systemd/resolved.conf.d
backup_path /etc/systemd/resolved.conf.d/99-hardening.conf

cat >/etc/systemd/resolved.conf.d/99-hardening.conf <<'DNS_EOF'
[Resolve]
# OpenDNS resolvers. Domains=~. gives this global configuration precedence
# over most per-link DNS configuration.
DNS=208.67.222.222 208.67.220.220
Domains=~.
DNSSEC=yes
# Opportunistic mode falls back to plaintext DNS if DoT is unavailable.
# Change to "yes" only after verifying that your network supports DoT.
DNSOverTLS=opportunistic
DNS_EOF

run "systemd-resolved restarted" systemctl restart systemd-resolved
check "DNS resolution works" getent hosts example.com
ok "DNSSEC enabled; DNS-over-TLS set to opportunistic"

# ─────────────────────────────────────────────────────────────
# 11. Restrict compiler access
# ─────────────────────────────────────────────────────────────
echo
echo "--- [11/14] Compiler access ---"

shopt -s nullglob
compilers=(
  /usr/bin/gcc
  /usr/bin/gcc-*
  /usr/bin/cc
  /usr/bin/g++
  /usr/bin/g++-*
)
shopt -u nullglob

if ((${#compilers[@]})); then
  for compiler in "${compilers[@]}"; do
    backup_mode "$compiler"
  done

  run "Compilers restricted from other users" chmod o-rx "${compilers[@]}"
else
  warn "No system compilers found; skipping"
fi

# ─────────────────────────────────────────────────────────────
# 12. Default umask
# ─────────────────────────────────────────────────────────────
echo
echo "--- [12/14] Default umask ---"

backup_path /etc/login.defs

if grep -qE '^UMASK[[:space:]]+027' /etc/login.defs; then
  ok "UMASK already set to 027"
else
  run "UMASK set to 027" \
    sed -i -E 's/^UMASK[[:space:]]+[0-9]+/UMASK\t\t027/' /etc/login.defs
  check "UMASK is 027" grep -qE '^UMASK[[:space:]]+027' /etc/login.defs
fi

# ─────────────────────────────────────────────────────────────
# 13. Login banners
# ─────────────────────────────────────────────────────────────
echo
echo "--- [13/14] Login banners ---"

backup_path /etc/issue
backup_path /etc/issue.net

cat >/etc/issue <<'EOF'
Authorized access only. All activity may be monitored and logged.
Unauthorized use is prohibited.
EOF

cp /etc/issue /etc/issue.net
ok "Login banners configured"

# ─────────────────────────────────────────────────────────────
# 14. Cron permissions and temporary-file cleanup
# ─────────────────────────────────────────────────────────────
echo
echo "--- [14/14] Cron permissions and temp cleanup ---"

if [[ -f /etc/crontab ]]; then
  backup_path /etc/crontab
  backup_mode /etc/crontab
  run "Set /etc/crontab mode to 600" chmod 600 /etc/crontab
fi

shopt -s nullglob
cron_dirs=(
  /etc/cron.d
  /etc/cron.hourly
  /etc/cron.daily
  /etc/cron.weekly
  /etc/cron.monthly
)
shopt -u nullglob

if ((${#cron_dirs[@]})); then
  for cron_dir in "${cron_dirs[@]}"; do
    backup_mode "$cron_dir"
  done

  run "Restricted cron directory permissions" chmod 700 "${cron_dirs[@]}"
fi

# Use systemd's supported cleanup mechanism rather than recursively
# deleting arbitrary files from /tmp.
run "Cleaned aged temporary files" systemd-tmpfiles --clean

# ─────────────────────────────────────────────────────────────
# Optional security tooling
# ─────────────────────────────────────────────────────────────
echo
echo "--- Optional: security tooling ---"

SECURITY_PACKAGES=(
  libpam-tmpdir
  needrestart
  debsums
  apt-show-versions
  auditd
  audispd-plugins
  aide
  libpam-pwquality
)

if apt-get install -y -qq "${SECURITY_PACKAGES[@]}" >>"$RUN_LOG" 2>&1; then
  ok "Security tooling installed"
else
  warn "Some security packages could not be installed; see $RUN_LOG"
fi

if systemctl list-unit-files auditd.service >/dev/null 2>&1; then
  run "auditd enabled" systemctl enable --now auditd
else
  warn "auditd is not installed; skipping"
fi

# ─────────────────────────────────────────────────────────────
# AIDE configuration
# ─────────────────────────────────────────────────────────────
echo
echo "--- Optional: AIDE configuration ---"

if [[ -f /etc/aide/aide.conf ]]; then
  backup_path /etc/aide/aide.conf

  if grep -qE '^[[:space:]]*Checksums[[:space:]]*=' /etc/aide/aide.conf; then
    run "AIDE checksum rule set to sha512" \
      sed -i -E 's/^[[:space:]]*Checksums[[:space:]]*=.*/Checksums = sha512/' \
      /etc/aide/aide.conf
  else
    printf '\nChecksums = sha512\n' >>/etc/aide/aide.conf
    ok "Appended AIDE checksum rule"
  fi

  if grep -qE '^Checksums[[:space:]]*=[[:space:]]*sha512' /etc/aide/aide.conf; then
    ok "AIDE checksum configuration verified"
  else
    fail "AIDE checksum configuration could not be verified"
    FAILED=$((FAILED + 1))
  fi

  warn "Initialize or regenerate the AIDE database after confirming this configuration."
else
  warn "AIDE is not installed; skipping configuration"
fi

# ─────────────────────────────────────────────────────────────
# Password hashing: report only; do not blindly change it
# ─────────────────────────────────────────────────────────────
echo
echo "--- Password hashing ---"

if grep -RqsE 'yescrypt' /etc/pam.d/common-password; then
  ok "PAM appears to use yescrypt password hashing"
elif grep -RqsE 'sha512crypt|sha512' /etc/pam.d/common-password; then
  warn "PAM appears to use SHA-512 password hashing"
else
  warn "Could not determine active PAM password-hashing configuration"
fi

warn "Do not rely on SHA_CRYPT_*_ROUNDS in /etc/login.defs unless your PAM stack actually uses SHA crypt."

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo
if ((FAILED > 0)); then
  fail "$FAILED step(s) failed."
else
  ok "All selected steps completed successfully."
fi

echo
echo "Rollback script: $ROLLBACK"
echo "Run log:         $RUN_LOG"
echo
warn "The rollback script restores files, file modes, and selected systemd unit"
warn "state. It cannot undo package removals or every service-level side effect."
echo
echo "Manual follow-ups:"
echo "  1. Enable full-disk encryption during a planned reinstall."
echo "  2. Set BIOS/UEFI supervisor and power-on passwords."
echo "  3. As your normal user, consider: chmod 700 /home/$SUDO_USER"
echo "  4. Initialize AIDE only after reviewing its configuration."
echo "  5. Remove services you do not use after confirming they are unnecessary."
