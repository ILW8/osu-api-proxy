#!/bin/sh
set -e

if [ -z "$UPSTREAM_PROXY_SECRET" ]; then
    echo "ERROR: UPSTREAM_PROXY_SECRET is not set" >&2
    exit 1
fi

# Substitute only our env var — leaves Nginx $variables intact
envsubst '${UPSTREAM_PROXY_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
