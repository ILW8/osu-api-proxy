# Egress Proxy Infrastructure

Two-tier HAProxy proxy deployed via Docker Swarm. Routes osu! API requests through
dedicated egress IPs instead of Cloudflare's shared pool. Includes Prometheus metrics
and Grafana dashboards for observability.

```
CF Worker / User --> entry HAProxy (per-user auth + throttle) --> worker HAProxy (global rate limit) --> osu.ppy.sh
                         :8404 HAProxy metrics                       :8404 HAProxy metrics
                         :3903 mtail metrics                         :3903 mtail metrics
                                \                                   /
                                 `-----> Prometheus -----> Grafana :3000
```

- **Entry service**: Pinned to nodes with a public IP. Authenticates users via
  `X-Upstream-Proxy-Secret` header validated against a per-user map file (`users.map`,
  deployed as a Docker secret). Rate-limits per user identity (for API v2) or per `?k=`
  param (for API v1) with Lua-based progressive throttling at 60 req/min sustained.
  Forwards to the worker service via Swarm overlay network.
- **Worker service**: Runs on every swarm node (`mode: global`). Enforces 130 req/min global
  rate limit per worker, then forwards to `osu.ppy.sh` over TLS with SNI. Each node uses
  its own egress IP.
- **Monitoring**: Prometheus scrapes HAProxy's built-in exporter (port 8404) and mtail
  (port 3903) on all proxies. mtail parses HAProxy access logs for per-status-code metrics,
  per-user request counts, and response duration histograms. Grafana provides dashboards.

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

### 3. Create the users.map Docker secret

Create a `users.map` file mapping per-user secrets to usernames:

```
# Generate a secret for each user:
# openssl rand -hex 32

<alice-secret> alice
<bob-secret> bob
<cf-worker-secret> cf-worker
```

Then create the Docker secret:

```bash
docker secret create users_map ./users.map
```

To update users later, use `./deploy.sh users` (see [Updating](#updating)).

### 4. Deploy the proxy stack

```bash
export REGISTRY="ghcr.io/<user>"

docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

The `--with-registry-auth` flag is required when using a private registry. It distributes
the manager's registry credentials to worker nodes via the Swarm raft log. Without it,
worker nodes fail to pull images even if they are individually authenticated.

### 5. Deploy the monitoring stack

```bash
cd monitoring
export GRAFANA_ADMIN_PASSWORD="your-secure-password"
docker stack deploy -c stack.yml osu-monitoring
```

### 6. Verify

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

### 7. Test

```bash
# Should return 401 (no proxy secret)
curl -v http://<entry-ip>:8080/api/v2/me

# Should return osu! API response (use a secret from your users.map)
curl -v \
  -H "X-Upstream-Proxy-Secret: <user-secret>" \
  -H "Authorization: Bearer <osu-token>" \
  http://<entry-ip>:8080/api/v2/me

# Check Prometheus metrics endpoints
curl http://<entry-ip>:8404/metrics   # HAProxy built-in exporter
curl http://<entry-ip>:3903/metrics   # mtail (per-status-code, duration)
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

- **Entry/Workers Request Rate**: Requests/s at each tier
- **Entry Denied Requests**: Auth failures (401) and path denials (403)
- **Workers Rate Limit Denials**: Per-worker global rate limit hits (429s)
- **Workers Rate Limit Utilization**: Percentage of each worker's 130 req/min limit used
- **Entry Throttled Requests**: Requests delayed by Lua throttle
- **Entry Throttle Delay**: p50/p95 injected delay when throttling is active
- **Entry Response Codes** (via mtail): Per-status-code breakdown (200, 401, 403, 429, etc.)
- **Entry Requests per User** (via mtail): Per-user request count from users.map identity
- **Workers Response Codes** (via mtail): Per-status-code breakdown across all workers
- **Response Duration per Worker** (via mtail): p50/p95 request duration from HAProxy logs

### Prometheus Metric Reference

**HAProxy built-in exporter** (port 8404):

| Metric | Description |
|---|---|
| `haproxy_frontend_http_requests_total` | Total HTTP requests per frontend |
| `haproxy_frontend_denied_req_total` | Requests denied by ACLs (auth + rate limits) |
| `haproxy_frontend_http_responses_total{code="4xx"}` | All 4xx responses by class |

**mtail** (port 3903, parsed from HAProxy access logs):

| Metric | Description |
|---|---|
| `haproxy_http_responses_total{frontend, status}` | Per-individual-status-code response count |
| `haproxy_http_duration_milliseconds_bucket{frontend}` | Request duration histogram |
| `haproxy_http_requests_by_user_total{user}` | Per-user request count (entry only) |
| `haproxy_throttled_requests_total{frontend}` | Throttled request count (entry only) |
| `haproxy_throttle_delay_milliseconds_bucket{frontend}` | Throttle delay histogram (entry only) |

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
# Enter: one of the per-user secrets from your users.map file
```

When these env vars are not set, the CF Worker connects directly to `osu.ppy.sh` as before.

## Updating

Use `deploy.sh` for routine updates:

```bash
./deploy.sh entry       # Rebuild + update entry proxy
./deploy.sh worker      # Rebuild + update worker proxy
./deploy.sh monitoring  # Redeploy monitoring stack (config changes)
./deploy.sh users       # Rotate the users.map Docker secret
./deploy.sh all         # Rebuild + update everything
```

Or redeploy the entire stack manually:

```bash
docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

## HAProxy Configuration Reference

### Entry Proxy (egress/entry/haproxy.cfg)

- **Auth**: Validates `X-Upstream-Proxy-Secret` against `users.map` (Docker secret at `/run/secrets/users_map`), returns 401 if not found
- **Path filtering**: Only allows `/api/*` and `/oauth/token*`, returns 403 otherwise
- **Rate limit key**: User identity from users.map (for v2 API), `?k=` query param (for v1 API)
- **Throttling**: Lua-based progressive delay when per-user rate exceeds 60 req/min sustained
- **Metrics**: HAProxy Prometheus exporter on port 8404, mtail on port 3903
- **Logging**: Dual output to stdout (Docker logs) and syslog (mtail), with user identity and throttle delay in log format

### Worker Proxy (egress/worker/haproxy.cfg)

- **Global rate limit**: Stick table with fixed `"global"` key, threshold 130 (120 + 10 burst)
- **Upstream**: TLS to `osu.ppy.sh:443` with SNI and certificate verification
- **DNS resolution**: Uses Docker embedded DNS (127.0.0.11) with periodic re-resolution
- **Header stripping**: Removes `X-Upstream-Proxy-Secret` before forwarding upstream
- **Metrics**: HAProxy Prometheus exporter on port 8404, mtail on port 3903

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
