# Home Directory Configuration

This repository contains configuration files for my home directory setup.

## Overview

This repository is designed to track only essential configuration files while ignoring all other files and directories in the home directory. The setup ensures clean version control focused on shell configuration and dotfiles.

## Tracked Files

Currently tracking:

- `.zshrc` - Zsh shell configuration

## Git Configuration

The repository uses a restrictive `.gitignore` that:

- Ignores all files by default (`*`)
- Keeps the `.gitignore` file itself visible (`!.gitignore`)
- Explicitly allows only `.zshrc` (`!.zshrc`)

## Usage

To add new configuration files to tracking:

1. Edit `.gitignore` to add exception rules (e.g., `!.vimrc`)
2. Add and commit the files as needed

## Structure

```
/
├── .gitignore         # Git ignore rules
├── README.md          # This file
└── .zshrc             # Zsh configuration (when added)
```

## Getting Started

1. Clone this repository to your home directory
2. The `.gitignore` ensures only intended files are tracked
3. Add your shell configuration files as needed

---

_This setup provides a clean way to version control dotfiles without cluttering the repository with unnecessary files._
