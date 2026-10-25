#!/usr/bin/env zsh

sudo -v

# ─── Helpers ───────────────────────────────────────────────────────
red() { printf "\033[1;31m%s\033[0m\n" "$1"; }
green() { printf "\033[1;32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$1"; }
blue() { printf "\033[1;34m%s\033[0m\n" "$1"; }

join_comma() {
  local -a lines=()
  local line
  while IFS= read -r line; do
    [[ -n $line ]] && lines+=("$line")
  done
  printf '%s' "${(j:, :)lines}"
}

echo_section() { blue ">>> $1"; }

update_summary=()
error_summary=()
updated_pip_packages=()

# ─── APT ───────────────────────────────────────────────────────────
if command -v apt-fast >/dev/null 2>&1; then
  echo_section "Updating apt packages"
  if ! sudo apt-fast update -qq; then
    error_summary+=("apt: update failed")
    echo "APT update failed."
  else
    # Simulate upgrade, suppress all output except what we need
    sim_out=$(sudo apt-fast upgrade -s -y 2>&1)
    if echo "$sim_out" | grep -q "^Inst "; then
      pkgs=$(echo "$sim_out" | awk '/^Inst / {print $2}' | sort -u)
      pkg_list=$(echo "$pkgs" | join_comma)
      echo "Upgrading: $pkg_list"
      sudo apt-fast upgrade -y >/dev/null 2>&1
      update_summary+=("apt: ${pkg_list}")
    fi
  fi
fi

# ─── SNAP ──────────────────────────────────────────────────────────
if command -v snap >/dev/null 2>&1; then
  echo_section "Updating Snap packages"
  snap_out=$(sudo snap refresh 2>&1)
  if echo "$snap_out" | grep -q "refreshed"; then
    pkgs=$(echo "$snap_out" | grep "refreshed" | awk '{print $1}' | join_comma)
    update_summary+=("snap: $pkgs")
  else
    echo "All snaps are up to date."
  fi
fi

# ─── FLATPAK ───────────────────────────────────────────────────────
if command -v flatpak >/dev/null 2>&1; then
  echo_section "Updating Flatpak packages"
  pkgs=$(flatpak remote-ls --updates --columns=application 2>/dev/null | sort -u)
  if [ -n "$pkgs" ]; then
    flatpak update -y >/dev/null 2>&1
    update_summary+=("flatpak: $(echo "$pkgs" | join_comma)")
  else
    echo "No Flatpak updates."
  fi
fi

# ─── BUN ───────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  echo_section "Updating global Bun packages"
  bun_out=$(bun update --latest -g 2>&1)
  bun_status=$?
  if [[ $bun_status -ne 0 ]]; then
    error_summary+=("bun: update failed (status $bun_status)")
  elif echo "$bun_out" | grep -q "→"; then
    pkgs=$(echo "$bun_out" |
      grep "→" |
      awk '{print $2}' |
      sort -u |
      join_comma)
    update_summary+=("bun: $pkgs")
  else
    echo "No Bun package changes."
  fi
fi

# ─── NPM (global) ──────────────────────────────────────────────────
if command -v npm >/dev/null 2>&1; then
  echo_section "Updating global npm packages"
  npm_outdated=$(npm outdated -g --json 2>/dev/null)
  if [ -n "$npm_outdated" ] && [ "$npm_outdated" != "{}" ]; then
    pkgs=$(echo "$npm_outdated" | jq -r 'keys[]' | sort -u | join_comma)
    npm update -g >/dev/null 2>&1
    if [ -n "$pkgs" ]; then
      update_summary+=("npm: $pkgs")
    fi
  else
    echo "No global npm updates."
  fi
fi

# ─── PIPX ──────────────────────────────────────────────────────────
if command -v pipx >/dev/null 2>&1; then
  echo_section "Upgrading pipx packages"
  temp_pipx_out=$(mktemp)
  pipx upgrade-all 2>&1 | tee "$temp_pipx_out"
  pipx_status=${pipestatus[1]}
  pipx_out=$(cat "$temp_pipx_out")
  rm "$temp_pipx_out"

  if [[ $pipx_status -ne 0 ]]; then
    error_summary+=("pipx: upgrade command failed with status $pipx_status")
  fi

  if echo "$pipx_out" | grep -iq "upgraded package"; then
    pkgs=$(echo "$pipx_out" | grep "upgraded package" | sed -E "s/upgraded package '([^']+)'.*/\1/" | join_comma)
    if [ -n "$pkgs" ]; then
      update_summary+=("pipx: $pkgs")
    fi
  fi
fi

# ─── UV TOOLS ──────────────────────────────────────────────────────
if command -v uv >/dev/null 2>&1; then
  echo_section "Updating uv tools"
  uv_out=$(uv tool upgrade --all 2>&1)
  # "Modified <name> environment" = tool deps upgraded
  upgraded=$(echo "$uv_out" | grep -oE "Modified ([a-zA-Z0-9_.-]+) environment" | awk '{print $2}' | sort -u)
  if [ -n "$upgraded" ]; then
    uv_list=$(echo "$upgraded" | join_comma)
    update_summary+=("uv-tools: $uv_list")
  else
    echo "All uv tools up to date."
  fi
fi

# ─── PIP (user) ───────────────────────────────────────────────────
if command -v pip >/dev/null 2>&1; then
  echo_section "Updating pip packages (user-installed)"
  pip_errors=()

  outdated_pkgs=$(pip list --user --outdated --format=json | jq -r '.[].name' 2>/dev/null)

  if [ -n "$outdated_pkgs" ]; then
    for pkg in ${(f)outdated_pkgs}; do
      echo "→ Updating $pkg ..."
      if pip install --user --upgrade --break-system-packages "$pkg" >/dev/null 2>&1; then
        updated_pip_packages+=("$pkg")
      else
        echo "  $(red "Failed to update $pkg")"
        pip_errors+=("$pkg")
      fi
    done

    if ((${#updated_pip_packages[@]} > 0)); then
      pip_list=$(printf ', %s' "${updated_pip_packages[@]}")
      pip_list=${pip_list#, }
      update_summary+=("pip (user): $pip_list")
    fi

    if ((${#pip_errors[@]} > 0)); then
      error_summary+=("pip: failed to update ${pip_errors[*]}")
    fi
  else
    echo "No outdated user packages."
  fi
fi

# ─── FINAL SUMMARY ─────────────────────────────────────────────────
echo "$(blue ">>> UPDATE SUMMARY")"
if ((${#update_summary[@]} > 0)); then
  for line in "${update_summary[@]}"; do
    echo "  $(green "✓") $line"
  done
else
  echo "  $(yellow "•") No packages were updated."
fi

# ─── ERROR SUMMARY ─────────────────────────────────────────────────
if ((${#error_summary[@]} > 0)); then
  echo "$(red ">>> Warning: ERROR SUMMARY")"
  for err in "${error_summary[@]}"; do
    echo "  $(red "✗") $err"
  done
fi
