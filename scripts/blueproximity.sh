#!/usr/bin/env bash

target_address='60:AB:67:45:54:8C'

while true
do
    rssi=$(hcitool rssi ${target_address} 2>/dev/null | grep -P -o '\d+')
    if [[ ${rssi} > 0 ]]
    then
        loginctl unlock-session
    fi
done

