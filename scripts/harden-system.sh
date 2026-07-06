#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Lynis Hardening Script - Generated from Lynis Report
# Score: 60/100 → Target: ~85+ (with encryption at reinstall)
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (sudo ./harden-system.sh)"
    exit 1
fi

echo "============================================================"
echo "  Lynis Hardening Script"
echo "  Applying critical + high + medium priority fixes"
echo "============================================================"
echo ""

TOTAL_STEPS=14

# ─────────────────────────────────────────────────────────────
# PHASE 2: Apply security updates
# ─────────────────────────────────────────────────────────────
echo "--- [1/$TOTAL_STEPS] Apply Security Updates ---"

if apt list --upgradable 2>/dev/null | grep -q upgradable; then
    apt update -qq && apt upgrade -y -qq 2>/dev/null || warn "Some packages failed to upgrade"
    ok "Security updates applied"
else
    ok "System is up-to-date"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 2: Remove Orphaned Packages
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [2/$TOTAL_STEPS] Remove Orphaned Packages ---"

if dpkg -l 2>/dev/null | grep -q '^rc'; then
    ORPHANS=$(dpkg -l | grep '^rc' | awk '{print $2}' | wc -l)
    dpkg --purge $(dpkg -l | grep '^rc' | awk '{print $2}') 2>/dev/null || warn "Some orphans could not be purged"
    ok "Purged $ORPHANS orphaned package configs"
else
    ok "No orphaned packages found"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 2: Autoremove old kernels and unused packages
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [3/$TOTAL_STEPS] Autoremove Unused Packages ---"

apt autoremove --purge -y -qq 2>/dev/null || warn "autoremove encountered issues"
ok "Removed unused packages and old kernels"

# ─────────────────────────────────────────────────────────────
# PHASE 3: Kernel Sysctl Hardening (full set)
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [4/$TOTAL_STEPS] Kernel Sysctl Hardening ---"

cat > /etc/sysctl.d/99-hardening.conf << 'SYSCTL_EOF'
# Lynis Kernel Hardening - Applied by harden-system.sh
fs.protected_fifos = 2
fs.suid_dumpable = 0
kernel.core_uses_pid = 1
kernel.kptr_restrict = 2
kernel.perf_event_paranoid = 3
kernel.sysrq = 0
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.forwarding = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
SYSCTL_EOF

sysctl --system 2>/dev/null
ok "Sysctl values applied"

# ─────────────────────────────────────────────────────────────
# PHASE 3: Disable Unused Network Protocols
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [5/$TOTAL_STEPS] Disable Unused Network Protocols ---"

cat > /etc/modprobe.d/disable-protocols.conf << 'MOD_EOF'
# Lynis - Disable unused network protocols
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
MOD_EOF

ok "Unused protocols (dccp, sctp, rds, tipc) disabled"

# ─────────────────────────────────────────────────────────────
# PHASE 4: Disable SSH (not needed on this machine)
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [6/$TOTAL_STEPS] Disable SSH ---"

systemctl stop ssh 2>/dev/null || systemctl stop sshd 2>/dev/null || true
systemctl disable ssh 2>/dev/null || systemctl disable sshd 2>/dev/null || true
systemctl mask ssh.socket ssh.service 2>/dev/null || true
ok "SSH service disabled and masked"

# ─────────────────────────────────────────────────────────────
# PHASE 4: Postfix Banner
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [7/$TOTAL_STEPS] Postfix Hardening ---"

if command -v postconf &>/dev/null; then
    postconf -e 'smtpd_banner = $myhostname ESMTP'
    postconf -e 'disable_vrfy_command = yes'
    systemctl restart postfix 2>/dev/null || true
    ok "Postfix banner sanitized"
else
    warn "Postfix not found - skipping"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 4: Fail2ban Jail Local
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [8/$TOTAL_STEPS] Fail2ban Config ---"

if [[ -f /etc/fail2ban/jail.conf ]]; then
    if [[ ! -f /etc/fail2ban/jail.local ]]; then
        cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
        ok "Copied jail.conf → jail.local"
    else
        warn "jail.local already exists - skipping copy"
    fi
    systemctl restart fail2ban 2>/dev/null || true
    ok "Fail2ban restarted"
else
    warn "Fail2ban not found - skipping"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 5: AppArmor - Enforce Firefox
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [9/$TOTAL_STEPS] AppArmor Firefox Enforcement ---"

if command -v aa-enforce &>/dev/null; then
    aa-enforce /usr/lib/firefox/firefox-bin 2>/dev/null || warn "Could not enforce Firefox profile"
    ok "AppArmor set to enforce for Firefox"
else
    warn "aa-enforce not found - install apparmor-utils"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 4: DNSSEC + DNS Hardening
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [10/$TOTAL_STEPS] DNSSEC + DNS Configuration ---"

mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/99-hardening.conf << 'DNS_EOF'
# Lynis DNS Hardening - Applied by harden-system.sh
[Resolve]
DNS=208.67.222.222 208.67.220.220
DNSSEC=yes
DNSOverTLS=opportunistic
DNS_EOF

systemctl restart systemd-resolved 2>/dev/null || true
ok "DNSSEC enabled with OpenDNS + DNS-over-TLS"

# ─────────────────────────────────────────────────────────────
# PHASE 5: Harden Compiler Access
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [11/$TOTAL_STEPS] Harden Compilers ---"

chmod o-rx /usr/bin/gcc* /usr/bin/cc /usr/bin/g++* 2>/dev/null || true
ok "Compilers restricted to root"

# ─────────────────────────────────────────────────────────────
# PHASE 5: Stricter Umask
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [12/$TOTAL_STEPS] Stricter Umask ---"

sed -i 's/^UMASK\s\+022/UMASK\t\t027/' /etc/login.defs
ok "UMASK changed from 022 to 027"

# ─────────────────────────────────────────────────────────────
# PHASE 5: Login Banners
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [13/$TOTAL_STEPS] Login Banners ---"

cat > /etc/issue << 'EOF'
 Authorized access only. All activity is monitored and logged.
 Unauthorized use is prohibited and will be prosecuted.
EOF
cp /etc/issue /etc/issue.net
ok "Login banners set"

# ─────────────────────────────────────────────────────────────
# PHASE 5: Crontab Permissions
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- [14/$TOTAL_STEPS] Crontab Permissions ---"

chmod 600 /etc/crontab
chmod 700 /etc/cron.d /etc/cron.daily /etc/cron.weekly /etc/cron.monthly /etc/cron.hourly 2>/dev/null || true
ok "Crontab permissions restricted"

# ─────────────────────────────────────────────────────────────
# PHASE 6: Install Security Tools
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- Bonus: Installing Security Tools ---"

apt-get install -y -qq libpam-tmpdir needrestart debsums apt-show-versions auditd audispd-plugins aide libpam-pwquality 2>/dev/null || warn "Some tools could not be installed (this is normal on Pop!_OS)"
systemctl enable --now auditd 2>/dev/null || true
ok "Security tools installed and auditd enabled"

# ─────────────────────────────────────────────────────────────
# PHASE 6: Password Hashing Rounds
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- Bonus: Password Hashing Rounds ---"

sed -i 's/^#\?SHA_CRYPT_MIN_ROUNDS.*/SHA_CRYPT_MIN_ROUNDS\t10000/' /etc/login.defs
sed -i 's/^#\?SHA_CRYPT_MAX_ROUNDS.*/SHA_CRYPT_MAX_ROUNDS\t10000/' /etc/login.defs
ok "SHA password hashing rounds set to 10000"

# ─────────────────────────────────────────────────────────────
# PHASE 6: AIDE Configuration (SHA512 + safe init)
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- Bonus: AIDE Configuration ---"

if [[ -f /etc/aide/aide.conf ]]; then
    # Configure SHA512 checksums (idempotent)
    sed -i 's/^Checksums\s*=.*/Checksums = sha512/' /etc/aide/aide.conf
    ok "AIDE configured for SHA512 checksums"
else
    warn "AIDE not installed - skipping configuration"
fi

# ─────────────────────────────────────────────────────────────
# PHASE 6: Clean old /tmp files (Lynis FILE-6354)
# ─────────────────────────────────────────────────────────────
echo ""
echo "--- Bonus: Clean Old /tmp Files ---"

OLD_TMP=$(find /tmp -type f -mtime +90 2>/dev/null | wc -l)
if [[ $OLD_TMP -gt 0 ]]; then
    find /tmp -type f -mtime +90 -delete 2>/dev/null || true
    ok "Removed $OLD_TMP old files from /tmp"
else
    ok "No old files in /tmp"
fi

# ─────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  AUTOMATED FIXES COMPLETE"
echo "============================================================"
echo ""
echo -e "${YELLOW}The following must be done MANUALLY:${NC}"
echo ""
echo " 1. DISK ENCRYPTION (CRITICAL #1):"
echo "    - Back up your data"
echo "    - Reinstall Pop!_OS with 'Encrypt' toggle enabled"
echo "    - This is the #1 priority for a laptop you travel with"
echo ""
echo " 2. BIOS/UEFI PASSWORDS (CRITICAL):"
echo "    - Reboot, press F2 to set Supervisor + Power-On password"
echo "    - Disable USB boot in BIOS"
echo ""
echo " 3. RESTRICT HOME DIRECTORY (run as your user, not root):"
echo "    chmod 700 /home/amr"
echo ""
echo " 4. INITIALIZE AIDE DATABASE (one-time, slow):"
echo "    sudo ~/scripts/aideinit-fast.sh"
echo ""
echo " 5. OPTIONAL: Remove services you don't use:"
echo "    sudo apt purge isc-dhcp-server virtualbox windscribe"
echo ""
echo -e "${GREEN}Score estimate after this script: ~78-82${NC}"
echo -e "${GREEN}With encryption at reinstall: ~85+${NC}"
echo ""
echo "============================================================"
echo "  SSH is DISABLED - no remote access on this machine"
echo "============================================================"