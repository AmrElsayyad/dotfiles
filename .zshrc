# ~/.zshrc
#
# Interactive Zsh configuration.
# Zim is the only framework initialized here.
# No Oh My Zsh plugins are sourced.

# Return rather than exit if this file is manually sourced
# from a non-interactive shell.
[[ -o interactive ]] || return

# ---------------------
# History
# ---------------------

HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"
HISTSIZE=100000
SAVEHIST=100000

# Share history between interactive shells.
setopt SHARE_HISTORY

# Remove older duplicates when adding commands to history.
setopt HIST_IGNORE_ALL_DUPS

# Do not save commands beginning with a space.
setopt HIST_IGNORE_SPACE

# Remove unnecessary blanks from history entries.
setopt HIST_REDUCE_BLANKS

# Avoid writing duplicate entries when saving history.
setopt HIST_SAVE_NO_DUPS

# ---------------------
# Input and editing
# ---------------------

# Preserve your current Emacs-style key bindings.
# Change this to "bindkey -v" if you prefer vi-mode.
bindkey -v

# Treat "/" as a word boundary for editing commands.
WORDCHARS=${WORDCHARS//[\/]}

# Preserve your previous preference for command correction.
# Comment out this line if correction prompts become distracting.
setopt CORRECT

SPROMPT='zsh: correct %F{red}%R%f to %F{green}%r%f [nyae]? '

# ---------------------
# Preferred editor
# ---------------------

if (( ${+commands[nvim]} )); then
  export EDITOR=nvim
  export VISUAL=nvim
  export SUDO_EDITOR=nvim
else
  export EDITOR=vi
  export VISUAL=vi
  export SUDO_EDITOR=vi
fi

# ---------------------
# Development environments
# ---------------------

# Rust / Cargo.
if [[ -r "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

# Go Version Manager.
if [[ -r "$HOME/.gvm/scripts/gvm" ]]; then
  source "$HOME/.gvm/scripts/gvm"
fi

# Fast Node Manager.
# Uses your configured default Node version.
# No automatic directory-based switching is enabled here.
if (( ${+commands[fnm]} )); then
  eval "$(fnm env --shell zsh)"
fi

# Java environment manager.
if (( ${+commands[jenv]} )); then
  eval "$(jenv init -)"
fi

# ---------------------
# Completion search paths
# ---------------------

# These must be set before Zim's completion module initializes.
typeset -U fpath

# Your custom completion definitions, including Alacritty.
if [[ -d "${ZDOTDIR:-$HOME}/.zsh_functions" ]]; then
  fpath=("${ZDOTDIR:-$HOME}/.zsh_functions" "${fpath[@]}")
fi

# Bun supplies an autoloadable completion file named "_bun".
# Make its directory available to Zsh completion instead of sourcing
# the completion definition directly.
if [[ -r "$BUN_INSTALL/_bun" ]]; then
  fpath=("$BUN_INSTALL" "${fpath[@]}")
fi

# ---------------------
# Zim module configuration
# ---------------------

# Keep Zim's default uppercase Git alias prefix.
# Exact personal shortcuts can be defined in ~/.zsh_aliases.
#
# To change the prefix, uncomment:
# zstyle ':zim:git' aliases-prefix 'g'

# Optional: expand additional dots into parent-directory components.
# zstyle ':zim:input' double-dot-expand yes

# Optional terminal title customization.
# zstyle ':zim:termtitle' format '%n@%m: %~'

# Match history entries only when they start with the typed text.
HISTORY_SUBSTRING_SEARCH_PREFIXED=1

# The autosuggestions module must remain last in ~/.zimrc
# when manual rebinding is enabled.
ZSH_AUTOSUGGEST_MANUAL_REBIND=1

# Optional suggestion appearance.
# ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=242'

ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets)

# ---------------------
# Initialize Zim
# ---------------------

ZIM_HOME="${ZDOTDIR:-$HOME}/.zim"

# Do not download executable code or install modules automatically
# during shell startup.
#
# After editing ~/.zimrc, run:
#   zimfw install
#   zimfw build
#
# If Zim has not yet been built, the shell still starts without it.
if [[ -r "$ZIM_HOME/init.zsh" ]]; then
  source "$ZIM_HOME/init.zsh"
else
  print -u2 -- "Zim initialization file is missing: $ZIM_HOME/init.zsh"
  print -u2 -- "Run: source \"$ZIM_HOME/zimfw.zsh\" install"
  print -u2 -- "Then run: source \"$ZIM_HOME/zimfw.zsh\" build"
fi

# ---------------------
# Navigation
# ---------------------

# Initialize once. Do not also load a zoxide module in ~/.zimrc.
if (( ${+commands[zoxide]} )); then
  eval "$(zoxide init zsh)"
fi

# ---------------------
# Personal aliases
# ---------------------

# Load after framework and tool initialization so your aliases win.
# Do not source ~/.zshenv here; Zsh has already read it.
if [[ -r "$HOME/.zsh_aliases" ]]; then
  source "$HOME/.zsh_aliases"
fi

# ---------------------
# Explicit system updates
# ---------------------

# Run updates only when requested, never on every shell startup.
# Usage: update-system
function update-system {
  local update_script="$HOME/scripts/update-system.sh"

  if [[ ! -f "$update_script" ]]; then
    print -u2 -- "Update script not found: $update_script"
    return 1
  fi

  if [[ ! -x "$update_script" ]]; then
    print -u2 -- "Update script is not executable: $update_script"
    print -u2 -- "Inspect it, then run: chmod u+x \"$update_script\""
    return 1
  fi

  "$update_script" "$@"
}

# ---------------------
# Git helpers
# ---------------------

# Print the name of the current Git branch.
# Prints nothing outside a Git repository or in detached-HEAD state.
function git_current_branch {
  git branch --show-current 2>/dev/null
}

# ---------------------
# Startup display
# ---------------------

# Display Fastfetch only for terminal sessions, not redirected output.
if [[ -t 0 && -t 1 ]] && (( ${+commands[fastfetch]} )); then
  command fastfetch
fi

