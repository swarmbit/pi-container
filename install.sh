#!/usr/bin/env bash 

npm run build
npm uninstall -g pi-container
npm install -g .
pi-container build