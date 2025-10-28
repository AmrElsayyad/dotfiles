#!/usr/bin/env zsh

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
print_header() { echo "\033[1;34m>>> $1\033[0m" }
declare -a update_summary

sudo -v

# ------------------------------------------------------------------
# APT
# ------------------------------------------------------------------
print_header "Updating apt packages..."
upgrade_output=$(aguu -y 2>&1)
upgraded_packages=$(echo "$upgrade_output" | grep -oP 'Unpacking \K[^ ]+' | sort -u)
if [[ -n "$upgraded_packages" ]]; then
    update_summary+=("apt upgrade: updated $(echo "$upgraded_packages" | tr '\n' ', ' | sed 's/, $//')")
else
    update_summary+=("apt upgrade: already up to date")
fi

# ------------------------------------------------------------------
# Snap
# ------------------------------------------------------------------
print_header "Updating Snap packages..."
refresh_output=$(sudo snap refresh 2>&1)
refreshed_packages=$(echo "$refresh_output" | grep -oP '^\K[^ ]+(?= \(.*\) was refreshed)' | sort -u)
if [[ -n "$refreshed_packages" ]]; then
    update_summary+=("snap: refreshed $(echo "$refreshed_packages" | tr '\n' ', ' | sed 's/, $//')")
else
    update_summary+=("snap: already up to date")
fi

# ------------------------------------------------------------------
# Flatpak
# ------------------------------------------------------------------
print_header "Updating Flatpak packages..."
if flatpak remote-ls --updates | grep -q .; then
    update_output=$(flatpak update -y 2>&1)
    updated_packages=$(echo "$update_output" | grep -oP 'Updating \K[^ ]+' | sort -u)
    if [[ -n "$updated_packages" ]]; then
        update_summary+=("flatpak: updated $(echo "$updated_packages" | tr '\n' ', ' | sed 's/, $//')")
    else
        update_summary+=("flatpak: no packages updated")
    fi
else
    update_summary+=("flatpak: already up to date")
fi

# ------------------------------------------------------------------
# Bun (global)
# ------------------------------------------------------------------
print_header "Updating global Bun packages..."
update_output=$(bun update --latest -g 2>&1)
if echo "$update_output" | grep -iq "updated"; then
    # Bun doesn't list names easily; note that updates occurred
    update_summary+=("bun: updated global packages")
else
    update_summary+=("bun: already up to date")
fi

# ------------------------------------------------------------------
# npm (global)
# ------------------------------------------------------------------
print_header "Updating global npm packages..."
outdated_npm=($(npm outdated -g --parseable 2>/dev/null | cut -d: -f2 | cut -d@ -f1))
if (( ${#outdated_npm[@]} )); then
    npm update -g > /dev/null 2>&1  # Suppress noisy output
    update_summary+=("npm: updated $(echo "${outdated_npm[@]}" | tr ' ' ', ')")
else
    update_summary+=("npm: already up to date")
fi

# ------------------------------------------------------------------
# pipx
# ------------------------------------------------------------------
print_header "Upgrading pipx packages..."
if pipx list --outdated 2>/dev/null | grep -q "would be upgraded"; then
    upgrade_output=$(pipx upgrade-all 2>&1)
    upgraded_packages=$(echo "$upgrade_output" | grep -oP 'upgraded \K[^ ]+' | sort -u)
    if [[ -n "$upgraded_packages" ]]; then
        update_summary+=("pipx: upgraded $(echo "$upgraded_packages" | tr '\n' ', ' | sed 's/, $//')")
    else
        update_summary+=("pipx: no packages upgraded")
    fi
else
    update_summary+=("pipx: already up to date")
fi

# ------------------------------------------------------------------
# pip (user-installed)
# ------------------------------------------------------------------
print_header "Updating pip packages (user-installed)..."
outdated_pip=($(pip list --outdated --format=columns 2>/dev/null | awk 'NR>2 {print $1}'))
if (( ${#outdated_pip[@]} )); then
    upgrade_output=$(pip install -U "${(@q)outdated_pip[@]}" 2>&1)
    upgraded_packages=$(echo "$upgrade_output" | grep -oP 'Successfully installed \K[^ ]+' | cut -d- -f1 | sort -u)
    if [[ -n "$upgraded_packages" ]]; then
        update_summary+=("pip: updated $(echo "$upgraded_packages" | tr '\n' ', ' | sed 's/, $//')")
    else
        update_summary+=("pip: no packages updated")
    fi
else
    update_summary+=("pip: already up to date")
fi

# ------------------------------------------------------------------
# FINAL SUMMARY (only show what was updated)
# ------------------------------------------------------------------
print_header "UPDATE SUMMARY"
updated_any=false
for line in "${update_summary[@]}"; do
    if [[ $line == *"(aglu)"* ]] || [[ $line == *"skipped"* ]] || [[ $line == *"no packages updated"* ]] || [[ $line == *"already up to date"* ]]; then
        continue  # Skip non-updates
    fi
    echo "  • $line"
    updated_any=true
done
if ! $updated_any; then
    echo "  No packages were updated."
fi

