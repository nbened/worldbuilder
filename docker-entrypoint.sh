#!/bin/sh
set -eu

# Railway allows one volume per service. Persist both trees under /data.
if [ -d /data ]; then
  mkdir -p /data/assets /data/out
  # Seed empty asset folders from the image when the volume is fresh.
  for dir in images maps music effects animations sounds videos; do
    mkdir -p "/data/assets/$dir"
  done
  rm -rf /app/assets /app/out
  ln -s /data/assets /app/assets
  ln -s /data/out /app/out
fi

exec python serve.py --no-open
