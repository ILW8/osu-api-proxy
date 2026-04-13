# Egress Proxy Infrastructure

Two-tier HAProxy proxy deployed via Docker Swarm. Routes osu! API requests through
dedicated egress IPs instead of Cloudflare's shared pool. Includes Prometheus metrics
and Grafana dashboards for observability.

```
CF Worker --> entry HAProxy (auth + per-token rate limit) --> worker HAProxy (global rate limit) --> osu.ppy.sh
                 :8404 /metrics                                   :8404 /metrics
                        \                                        /
                         `-----> Prometheus -----> Grafana :3000
```

- **Entry service**: Pinned to nodes with a public IP. Validates `X-Upstream-Proxy-Secret`,
  rate-limits at 90 req/min per osu! API token (keyed on `Authorization` header for API v2,
  `?k=` query param for API v1). Forwards to the worker service via Swarm overlay network.
- **Worker service**: Runs on every swarm node (`mode: global`). Enforces 130 req/min global
  rate limit per worker, then forwards to `osu.ppy.sh` over TLS with SNI. Each node uses
  its own egress IP.
- **Monitoring**: Prometheus scrapes HAProxy metrics from all proxies. Grafana provides
  dashboards for request rates, rate-limit denials, and backend response times.

## Prerequisites

- Docker Swarm initialized with nodes joined
- Swarm management ports open between nodes: 2377/tcp, 7946/tcp+udp, 4789/udp
- All nodes authenticated to your container registry (e.g., `docker login ghcr.io`)

## Initial Swarm Setup

```bash
# On the manager node
docker swarm init --advertise-addr <vpn-ip> --listen-addr <vpn-ip>:2377

# On each worker node
docker swarm join --advertise-addr <vpn-ip> --token <token> <manager-vpn-ip>:2377
```

Bind to VPN interface IPs -- never expose swarm ports to the public internet. Swarm uses
mutual TLS, but defense in depth means keeping management traffic on the private network.

### Overlay Network Setup

The proxy and monitoring stacks share a manually-created overlay network. This decouples
the network lifecycle from either stack -- either can be torn down and redeployed without
breaking the other.

```bash
docker network create -d overlay --attachable \
    --opt com.docker.network.driver.mtu=1230 \
    osu-proxy
```

The MTU is set to 1230 to account for VPN tunnel overhead (Tailscale MTU 1280 minus 50
bytes VXLAN overhead). If your VPN uses a different MTU, adjust: `overlay MTU = VPN MTU - 50`.
Check your VPN MTU with `ip link show tailscale0`.

**Note:** MTU cannot be changed on an existing overlay network. To change it, remove the
network (after tearing down both stacks) and recreate it.

### Tailscale + Docker DNS Conflict

If you run Tailscale on your swarm nodes, MagicDNS adds a `search <tailnet>.ts.net` entry
to the host's `/etc/resolv.conf`. Docker inherits this into containers, which breaks Swarm
service name resolution: a lookup for `worker` gets expanded to `worker.<tailnet>.ts.net`
and fails with NXDOMAIN.

The `tasks.<service>` prefix still works (Docker intercepts it internally), but the standard
service VIP name does not.

**Fix:** Override the DNS search domain at the Docker daemon level on affected nodes:

```bash
# /etc/docker/daemon.json
{
  "dns-search": ["."]
}
```

Then restart Docker: `sudo systemctl restart docker`.

See: https://github.com/tailscale/tailscale/issues/12108,
https://github.com/moby/moby/issues/41819

## Building Images

### Multi-platform builds (required if nodes have mixed architectures)

If your swarm includes both amd64 and arm64 nodes:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<user>/osu-proxy-entry:latest --push ./entry

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<user>/osu-proxy-worker:latest --push ./worker
```

### Single-platform builds

```bash
docker build -t <registry>/osu-proxy-entry:latest ./entry
docker build -t <registry>/osu-proxy-worker:latest ./worker
docker push <registry>/osu-proxy-entry:latest
docker push <registry>/osu-proxy-worker:latest
```

## Deploying

### 1. Create the overlay network (if not already created)

```bash
docker network create -d overlay --attachable \
    --opt com.docker.network.driver.mtu=1230 \
    osu-proxy
```

### 2. Label the public-facing node

```bash
docker node ls
docker node update --label-add public=true <node-id>
```

The entry service is constrained to nodes with this label.

### 3. Deploy the proxy stack

```bash
export UPSTREAM_PROXY_SECRET="$(openssl rand -hex 32)"
export REGISTRY="ghcr.io/<user>"

docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

The `--with-registry-auth` flag is required when using a private registry. It distributes
the manager's registry credentials to worker nodes via the Swarm raft log. Without it,
worker nodes fail to pull images even if they are individually authenticated.

### 4. Deploy the monitoring stack

```bash
cd monitoring
export GRAFANA_ADMIN_PASSWORD="your-secure-password"
docker stack deploy -c stack.yml osu-monitoring
```

### 5. Verify

```bash
# Check all replicas are running
docker stack services osu-proxy
docker stack services osu-monitoring

# Check per-node status and error messages
docker service ps osu-proxy_worker --no-trunc
docker service ps osu-proxy_entry --no-trunc

# Check logs
docker service logs osu-proxy_entry
docker service logs osu-proxy_worker
```

### 6. Test

```bash
# Should return 401 (no proxy secret)
curl -v http://<entry-ip>:8080/api/v2/me

# Should return osu! API response
curl -v \
  -H "X-Upstream-Proxy-Secret: $UPSTREAM_PROXY_SECRET" \
  -H "Authorization: Bearer <osu-token>" \
  http://<entry-ip>:8080/api/v2/me

# Check Prometheus metrics endpoint
curl http://<entry-ip>:8404/metrics
```

## Monitoring

### Prometheus

Prometheus scrapes HAProxy metrics from both the entry and worker services using Docker
Swarm DNS service discovery (`tasks.<stack>_<service>` resolves to individual container IPs).

Targets are configured in `monitoring/prometheus/prometheus.yml`. The `tasks.*` names
depend on the proxy stack name used at deploy time. If you deployed with a name other
than `osu-proxy`, update the DNS names accordingly.

### Grafana

Grafana is accessible on port 3000. The default credentials are `admin` / the value of
`GRAFANA_ADMIN_PASSWORD` (defaults to `admin` if not set).

A pre-provisioned dashboard ("osu! API Proxy") is available in the `osu-proxy` folder
with these panels:

- **Entry Request Rate**: Total requests/s hitting the entry proxy
- **Workers Request Rate**: Per-worker requests/s (one line per swarm node)
- **Entry Rate Limit Denials**: Per-token rate limit hits (429s) at the entry
- **Workers Rate Limit Denials**: Per-worker global rate limit hits (429s)
- **Entry Auth Failures**: Requests rejected for invalid proxy secret (401s)
- **Backend Response Time**: Average upstream response time from osu.ppy.sh

**Metric separation:** Auth failures use `http-request return` (not counted in
`denied_req_total`), while rate-limit denials use `http-request deny` (counted in
`denied_req_total`). This allows clean separation in Grafana queries.

### Prometheus Metric Reference

| Metric | Description |
|---|---|
| `haproxy_frontend_http_requests_total` | Total HTTP requests per frontend |
| `haproxy_frontend_denied_req_total` | Requests denied by ACLs (rate limits only, not auth) |
| `haproxy_frontend_http_responses_total{code="4xx"}` | All 4xx responses (auth failures + rate limits) |
| `haproxy_backend_response_time_average_seconds` | Average backend response time |

## TLS with Cloudflare Tunnel

Rather than managing TLS certificates on the entry node, use a Cloudflare Tunnel to
provide HTTPS termination:

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create osu-proxy

# Configure: ~/.cloudflared/config.yml
# tunnel: <tunnel-uuid>
# credentials-file: /home/<user>/.cloudflared/<tunnel-uuid>.json
#
# ingress:
#   - hostname: osu-proxy.yourdomain.com
#     service: http://localhost:8080
#   - service: http_status:404

# Create DNS record
cloudflared tunnel route dns osu-proxy osu-proxy.yourdomain.com

# Run as a service
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Once the tunnel is running, port 8080 no longer needs to be exposed publicly. Firewall
it to localhost only.

## Configuring the CF Worker

Set these as secrets in Cloudflare (not in `wrangler.toml`, which is committed to git):

```bash
wrangler secret put OSU_ORIGIN
# Enter: https://osu-proxy.yourdomain.com (tunnel) or http://<entry-ip>:8080 (direct)

wrangler secret put UPSTREAM_PROXY_SECRET
# Enter: the secret from the deploy step
```

When these env vars are not set, the CF Worker connects directly to `osu.ppy.sh` as before.

## Updating

After modifying configs, rebuild and push images, then force the services to pull:

```bash
docker service update --force osu-proxy_entry
docker service update --force osu-proxy_worker
```

Or redeploy the entire stack:

```bash
docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

## HAProxy Configuration Reference

### Entry Proxy (egress/entry/haproxy.cfg.template)

- **Auth**: Validates `X-Upstream-Proxy-Secret` header via `http-request return status 401`
- **Rate limit key**: `Authorization` header, falls back to `?k=` query param
- **Rate limit**: Stick table with `http_req_rate(60s)`, threshold 90 (60 sustained + 30 burst)
- **Metrics**: Prometheus exporter on port 8404 at `/metrics`
- **Secret injection**: `${UPSTREAM_PROXY_SECRET}` substituted at container startup via `envsubst`

### Worker Proxy (egress/worker/haproxy.cfg)

- **Global rate limit**: Stick table with fixed `"global"` key, threshold 130 (120 + 10 burst)
- **Upstream**: TLS to `osu.ppy.sh:443` with SNI and certificate verification
- **DNS resolution**: Uses Docker embedded DNS (127.0.0.11) with periodic re-resolution
- **Header stripping**: Removes `X-Upstream-Proxy-Secret` before forwarding upstream
- **Metrics**: Prometheus exporter on port 8404 at `/metrics`

## Leaving the Swarm

A node can leave the swarm without affecting standalone containers that were running
before it joined:

```bash
# On a worker node
docker swarm leave

# On the manager (if last node) -- workers should leave first
docker swarm leave --force
```

Swarm-managed services and overlay networks are removed. Standalone containers on
standard bridge/host networking are unaffected.

**Caveat:** If any standalone container is attached to the `osu-proxy` overlay network
(via `--attachable`), it will lose that network interface when the node leaves.
