export PATH="$HOME/.opencode/bin:$HOME/.turso:$HOME/.jenv/bin:$BUN_INSTALL/bin:$HOME/.local/bin:$PATH:$HOME/scripts"

export BUN_INSTALL="$HOME/.bun"
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
export ZSH="$HOME/.oh-my-zsh"

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
    bun
    colored-man-pages
    colorize
    copyfile
    copypath
    cp
    docker
    docker-compose
    eza
    fnm
    fzf
    gh
    git
    golang
    gradle
    history
    k9s
    kubectl
    mvn
    npm
    nvm
    podman
    python
    rclone
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
    zoxide
    zsh-autosuggestions
    zsh-fzf-history-search
    zsh-syntax-highlighting
)

source $ZSH/oh-my-zsh.sh

alias rsync-copy='rsync -avz --info=progress2 -h'
alias rsync-move='rsync -avz --info=progress2 -h --remove-source-files'
alias rsync-synchronize='rsync -avzu --delete --info=progress2 -h'
alias rsync-update='rsync -avzu --info=progress2 -h'

DOCKER_FORMAT="{{.Image}}\t{{.Status}}\t{{.Ports}}"
alias dcps="docker compose ps --format 'table {{.Name}}\t${DOCKER_FORMAT}'"
alias dps="docker ps --format 'table {{.Names}}\t${DOCKER_FORMAT}'"
alias dpsa="docker ps -a --format 'table {{.Names}}\t${DOCKER_FORMAT}'"

alias fd=fdfind
alias oc=opencode
alias p=popd
alias snap="sudo snap"
alias v=nvim

