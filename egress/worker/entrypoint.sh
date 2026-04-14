#!/bin/sh
set -e

# Start syslogd to capture HAProxy logs for mtail
mkdir -p /var/log
touch /var/log/haproxy.log
syslogd -n -O /var/log/haproxy.log &
sleep 1

# Start mtail to extract per-status-code metrics from logs
mtail --progs /etc/mtail --logs /var/log/haproxy.log --port 3903 &

exec haproxy -db -f /usr/local/etc/haproxy/haproxy.cfg
