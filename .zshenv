# autoenv
source '/home/amr/.local/share/fnm/node-versions/v22.14.0/installation/lib/node_modules/@hyperupcall/autoenv/activate.sh'

export ZSH="$HOME/.oh-my-zsh"

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
    k9s
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
    zsh-autosuggestions
    zsh-syntax-highlighting
)

. $ZSH/oh-my-zsh.sh

. "$HOME/.cargo/env"

