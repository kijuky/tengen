#!/bin/sh
cd "$(dirname "$0")"
touch yarn.lock
yarn set version classic
# will install axios@1.7.9
yarn install --cache-folder ./.yarn-cache
