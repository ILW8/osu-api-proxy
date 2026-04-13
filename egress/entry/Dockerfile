FROM haproxy:lts-alpine
USER root
ARG TARGETARCH
RUN apk add --no-cache gettext && \
    wget -qO /tmp/mtail.tar.gz "https://github.com/google/mtail/releases/download/v3.0.8/mtail_3.0.8_linux_${TARGETARCH}.tar.gz" && \
    cd /tmp && tar xzf mtail.tar.gz && \
    mv /tmp/mtail /usr/local/bin/mtail && \
    chmod +x /usr/local/bin/mtail && \
    rm -rf /tmp/mtail* && \
    mkdir -p /etc/mtail
COPY haproxy.cfg.template /usr/local/etc/haproxy/haproxy.cfg.template
COPY throttle.lua /usr/local/etc/haproxy/throttle.lua
COPY haproxy.mtail /etc/mtail/haproxy.mtail
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
