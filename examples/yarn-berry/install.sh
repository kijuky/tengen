#!/bin/sh
cd "$(dirname "$0")"
touch yarn.lock
yarn set version berry
# will install axios@1.7.9
yarn install
