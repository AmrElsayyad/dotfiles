# Home Directory Dotfiles

Personal dotfiles managed using [chezmoi](https://www.chezmoi.io/).

## Overview

This repository contains my personal configurations for terminal emulators, shells, Neovim, Tmux, custom scripts, and AI coding tool environments (OpenCode).

## Installation

To initialize and apply these dotfiles on a new machine:

```sh
sh -c "$(curl -fsLS [https://get.chezmoi.io](https://get.chezmoi.io))" -- init --apply AmrElsayyad

```

## Daily Usage

- **Apply changes:**

```sh
chezmoi apply

```

- **Edit a file:**

```sh
chezmoi edit ~/.zshrc

```

- **Add a new file to tracking:**

```sh
chezmoi add ~/.config/some-app/config.toml

```

- **Check diff between target and source state:**

```sh
chezmoi diff

```
