#!/bin/env bash

for i in {2..180}
do
	ssh -o ConnectTimeout=1 -o BatchMode=yes ubuntu@10.1.1.$i exit
	if [ $? -eq 0 ]
	then
		echo "Connected to ubuntu@10.1.1.$i"
		break
	fi
done
