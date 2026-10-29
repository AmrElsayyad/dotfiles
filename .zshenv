# ~/.zshenv
#
# Environment configuration for every Zsh invocation.
# Keep this file quiet: no plugins, prompts, aliases, or interactive commands.

# ---------------------
# Tool installation paths
# ---------------------

export BUN_INSTALL="$HOME/.bun"
export FNM_PATH="$HOME/.local/share/fnm"
export PNPM_HOME="$HOME/.local/share/pnpm"

# ---------------------
# PATH
# ---------------------

# Zsh ties the path array to PATH.
# Keep only the first occurrence of each directory.
typeset -U path

path=(
  "$BUN_INSTALL/bin"
  "$FNM_PATH"
  "$HOME/.fzf/bin"
  "$HOME/.jenv/bin"
  "$HOME/.local/bin"
  "$HOME/.opencode/bin"
  "$HOME/.turso"
  "$HOME/scripts"
  "$PNPM_HOME/bin"
  "${path[@]}"
)

export PATH

# ---------------------
# Application configuration
# ---------------------

export CAVEMAN_DEFAULT_MODE=full
export COMPOSE_BAKE=true
export DO_NOT_TRACK=1
export LLAMA_CPP_PATH="$HOME/.local/bin"
export NVIM_DIR="$HOME/.config/nvim"

export OMNIROUTE_CHAT_ADMISSION_QUEUE_MS=5000
export OMNIROUTE_CHAT_MAX_HEAVY_IN_FLIGHT=4
export OMNIROUTE_ROTATE_ON_400=true

export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=128000
export REQUIRE_API_KEY=true

# export SKILLSPECTOR_MODEL=glm-5.2
export SKILLSPECTOR_PROVIDER=nv_build
