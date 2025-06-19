# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time Oh My Zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="robbyrussell"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Fast Node Manager
FNM_PATH="/home/amr/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
    export PATH="/home/amr/.local/share/fnm:$PATH"
    eval "`fnm env`"
fi

# autoenv
source '/home/amr/.local/share/fnm/node-versions/v22.14.0/installation/lib/node_modules/@hyperupcall/autoenv/activate.sh'

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
    autoenv
    bun
    colored-man-pages
    colorize
    cp
    deno
    docker
    docker-compose
    fnm
    fzf
    gh
    git
    golang
    history
    kubectl
    mvn
    npm
    nvm
    podman
    python
    rclone
    rsync
    rust
    screen
    snap
    sudo
    systemd
    timer
    tmux
    ubuntu
    uv
    vi-mode
)

source $ZSH/oh-my-zsh.sh

# Load environment variables from .env file
if [ -f "$HOME/.env" ]; then
    source "$HOME/.env"
fi

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
    export EDITOR='vi'
else
    export EDITOR='nvim'
    export SUDO_EDITOR='nvim'
fi

# Compilation flags
# export ARCHFLAGS="-arch $(uname -m)"

# Set personal aliases, overriding those provided by Oh My Zsh libs,
# plugins, and themes. Aliases can be placed here, though Oh My Zsh
# users are encouraged to define aliases within a top-level file in
# the $ZSH_CUSTOM folder, with .zsh extension. Examples:
# - $ZSH_CUSTOM/aliases.zsh
# - $ZSH_CUSTOM/macos.zsh
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Alacritty completions
fpath+=${ZDOTDIR:-~}/.zsh_functions

# User scripts
export PATH=$PATH:~/scripts

# Use Bake for Docker Compose
export COMPOSE_BAKE=true

# Docker aliases
DOCKER_FORMAT="{{.Image}}\t{{.Status}}\t{{.Ports}}"
alias dcps="docker compose ps --format 'table {{.Name}}\t${DOCKER_FORMAT}'"
alias dps="docker ps --format 'table {{.Names}}\t${DOCKER_FORMAT}'"
alias dpsa="docker ps -a --format 'table {{.Names}}\t${DOCKER_FORMAT}'"

# Podman Compose Provider
export PODMAN_COMPOSE_PROVIDER=podman-compose

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH=$BUN_INSTALL/bin:$PATH

# go version manager
[[ -s "/home/amr/.gvm/scripts/gvm" ]] && source "/home/amr/.gvm/scripts/gvm"

# Turso
export PATH="$PATH:/home/amr/.turso"

# cursor
alias cursor="~/Applications/Cursor-0.50-x86_64.AppImage"

# Fastfetch
fastfetch

# Connect Bluetooth headphones automatically
LOGITECH_SPEAKERS="$(bluetoothctl paired-devices | grep Logi | cut -d ' ' -f 2)"
if ! bluetoothctl info $LOGITECH_SPEAKERS | grep -q "Connected: yes"; then
    bluetoothctl connect $LOGITECH_SPEAKERS
fi

