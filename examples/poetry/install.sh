#!/bin/sh

# will install requests@2.32.3
POETRY_CACHE_DIR=$(pwd)/.cache poetry install --no-root
