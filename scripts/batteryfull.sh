#!/usr/bin/env bash

# Set battery percentage thresholds
BATTERY_LOW_PERCENTAGE=30
BATTERY_HIGH_PERCENTAGE=90

# Set battery check interval in seconds
BATTERY_CHECK_INTERVAL=60

# Paths to sound files
LOW_BATTERY_SOUND="/usr/share/sounds/Pop/stereo/alert/battery-low.oga"
FULL_BATTERY_SOUND="/usr/share/sounds/Pop/stereo/alert/alarm-clock-elapsed.oga"

# Paths to icon files
LOW_BATTERY_ICON="/usr/share/icons/Pop/scalable/status/battery-level-10-symbolic.svg"
FULL_BATTERY_ICON="/usr/share/icons/Pop/scalable/status/battery-level-100-charged-symbolic.svg"

# Check if dunstify is available
if [ ! command -v dunstify ] &>/dev/null; then

    echo "Please, install dunstify using: sudo apt update && sudo apt install dunst"
    exit

fi

# Ensure paplay is available
if [ ! command -v paplay ] &>/dev/null; then

    echo "Please, install paplay using: sudo apt update && sudo apt install pulseaudio-utils"
    exit

fi

# Function to check battery status
check_battery() {

    local battery_info=$(upower -i $(upower -e | grep BAT))
    local state=$(echo "$battery_info" | awk '/state/ {print $2}')
    local percentage=$(echo "$battery_info" | awk '/percentage/ {gsub(/%/, "", $2); print $2}')

    if [[ "$state" == "charging" ]]; then

        if [[ "$percentage" -gt "$BATTERY_HIGH_PERCENTAGE" ]]; then

            NOTIFY_ID=$(dunstify -p -r ${NOTIFY_ID-0} -i "$FULL_BATTERY_ICON" "Battery Full" \
                "Battery is at $percentage%. Unplug the charger.")

            paplay "$FULL_BATTERY_SOUND"

        elif [ ! -z $NOTIFY_ID ]; then

            dunstify -C $NOTIFY_ID
            unset NOTIFY_ID

        fi

    elif [[ "$state" == "discharging" ]]; then

        if [[ "$percentage" -lt "$BATTERY_LOW_PERCENTAGE" ]]; then

            NOTIFY_ID=$(dunstify -p -r ${NOTIFY_ID-0} -i "$LOW_BATTERY_ICON" "Battery Low" \
                "Battery is at $percentage%. Plug in the charger.")

            paplay "$LOW_BATTERY_SOUND"

        elif [ ! -z $NOTIFY_ID ]; then

            dunstify -C $NOTIFY_ID
            unset NOTIFY_ID

        fi

    fi
}

# Main loop
while true; do

    check_battery
    sleep $BATTERY_CHECK_INTERVAL

done
