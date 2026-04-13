#!/bin/sh
set -e

if [ -z "$UPSTREAM_PROXY_SECRET" ]; then
    echo "ERROR: UPSTREAM_PROXY_SECRET is not set" >&2
    exit 1
fi

envsubst '${UPSTREAM_PROXY_SECRET}' \
    < /usr/local/etc/haproxy/haproxy.cfg.template \
    > /usr/local/etc/haproxy/haproxy.cfg

exec haproxy -f /usr/local/etc/haproxy/haproxy.cfg
