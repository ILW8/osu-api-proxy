FROM haproxy:lts-alpine
USER root
RUN apk add --no-cache gettext
COPY haproxy.cfg.template /usr/local/etc/haproxy/haproxy.cfg.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER haproxy
ENTRYPOINT ["/entrypoint.sh"]
