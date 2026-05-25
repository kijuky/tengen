#!/bin/sh
set -e
cd "$(dirname "$0")"
GOENV=$(pwd)/go.env GOMODCACHE=$(pwd)/.gomodcache go clean -modcache
rm -f go.mod go.sum
