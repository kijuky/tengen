#!/bin/sh

TARGET_EPOCH=$(date -j -f "%Y-%m-%d" "2025-01-01" +%s)
NOW_EPOCH=$(date +%s)
DAYS=$(( (NOW_EPOCH - TARGET_EPOCH) / 86400 ))

echo "Days until 2025-01-01: ${DAYS} -> starting server with -d ${DAYS}"

cd "$(dirname "$0")/.." && node src/index.ts -d "$DAYS" -p 3000
