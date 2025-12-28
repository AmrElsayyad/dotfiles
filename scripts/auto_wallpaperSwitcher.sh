#!/bin/bash

WALLPAPER_DIR="$HOME/snap/bing-wall/30/.local/share/org.keshavnrj.ubuntu/BingWall/downloaded" # Folder containing wallpapers
INTERVAL=300                                                                                  # Time between changes in seconds
RANDOM_MODE=true                                                                              # Set to false for sequential mode

if ! command -v "swaybg" >/dev/null 2>&1; then
  notify-send "Variety Error" "Please install 'swaybg' to set wallpapers on COSMIC."
  exit 1
fi

while true; do
  if $RANDOM_MODE; then
    img=$(find "$WALLPAPER_DIR" -type f | shuf -n 1)
  else
    for img in "$WALLPAPER_DIR"/*; do
      # Kill any existing swaybg instances to prevent duplicates
      pkill swaybg
      # Start swaybg in the background with the new image
      swaybg -i "$img" -m fill &
      sleep $INTERVAL
    done
    continue
  fi

  # Kill any existing swaybg instances to prevent duplicates
  pkill swaybg
  # Start swaybg in the background with the new image
  swaybg -i "$img" -m fill &
  sleep $INTERVAL
done
