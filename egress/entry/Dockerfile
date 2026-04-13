FROM haproxy:lts-alpine
RUN apk add --no-cache gettext
COPY haproxy.cfg.template /usr/local/etc/haproxy/haproxy.cfg.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
