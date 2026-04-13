#!/bin/sh
set -e

if [ -z "$UPSTREAM_PROXY_SECRET" ]; then
    echo "ERROR: UPSTREAM_PROXY_SECRET is not set" >&2
    exit 1
fi

envsubst '${UPSTREAM_PROXY_SECRET}' \
    < /usr/local/etc/haproxy/haproxy.cfg.template \
    > /tmp/haproxy.cfg

exec haproxy -f /tmp/haproxy.cfg
