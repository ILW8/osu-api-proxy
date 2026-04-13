# Egress Proxy Infrastructure

Two-tier Nginx proxy deployed via Docker Swarm. Routes osu! API requests through
dedicated egress IPs instead of Cloudflare's shared pool.

```
CF Worker --> entry proxy (auth + per-token rate limit) --> worker proxy (global rate limit) --> osu.ppy.sh
```

- **Entry service**: Pinned to nodes with a public IP. Validates `X-Upstream-Proxy-Secret`,
  rate-limits at 30 req/min per osu! API token (keyed on `Authorization` header for API v2,
  `?k=` query param for API v1). Forwards to the worker service via Swarm overlay network.
- **Worker service**: Runs on every swarm node (`mode: global`). Enforces 120 req/min global
  rate limit per worker, then forwards to `osu.ppy.sh`. Each node uses its own egress IP.

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

### Overlay Network MTU on VPN

Docker's overlay network defaults to MTU 1450. VPN tunnels already reduce the link MTU
(Tailscale/WireGuard typically ~1280), so the VXLAN encapsulation overhead (50 bytes)
pushes packets over the limit. Symptom: DNS resolution works between containers but HTTP
requests to containers on other nodes time out (small packets fit, large packets are
silently dropped).

The `stack.yml` sets the overlay MTU to 1230 to account for this (Tailscale MTU 1280
minus 50 bytes VXLAN overhead). If your VPN uses a different MTU, adjust the formula:
`overlay MTU = VPN MTU - 50`. Check your VPN MTU with `ip link show tailscale0` (or
your VPN interface). Adjust `com.docker.network.driver.mtu` in the stack file accordingly. Note: MTU cannot be changed on an existing overlay network -- you must
remove and redeploy the stack:

```bash
docker stack rm osu-proxy
docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

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

This prevents the Tailscale search domain from leaking into containers. Containers lose
the ability to resolve Tailscale MagicDNS names, but swarm services don't need that.

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

### 1. Label the public-facing node

```bash
docker node ls
docker node update --label-add public=true <node-id>
```

The entry service is constrained to nodes with this label.

### 2. Deploy the stack

```bash
export UPSTREAM_PROXY_SECRET="$(openssl rand -hex 32)"
export REGISTRY="ghcr.io/<user>"

docker stack deploy -c stack.yml osu-proxy --with-registry-auth
```

The `--with-registry-auth` flag is required when using a private registry. It distributes
the manager's registry credentials to worker nodes via the Swarm raft log. Without it,
worker nodes fail to pull images even if they are individually authenticated.

### 3. Verify

```bash
# Check all replicas are running
docker stack services osu-proxy

# Check per-node status and error messages
docker service ps osu-proxy_worker --no-trunc
docker service ps osu-proxy_entry --no-trunc

# Check logs
docker service logs osu-proxy_entry
docker service logs osu-proxy_worker
```

### 4. Test

```bash
# Should return 401 (no proxy secret)
curl -v http://<entry-ip>:8080/api/v2/me

# Should return osu! API response
curl -v \
  -H "X-Upstream-Proxy-Secret: $UPSTREAM_PROXY_SECRET" \
  -H "Authorization: Bearer <osu-token>" \
  http://<entry-ip>:8080/api/v2/me
```

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

**Caveat:** If any standalone container is attached to a swarm overlay network
(via `attachable: true`), it will lose that network interface when the node leaves.
