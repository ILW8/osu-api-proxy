#!/bin/sh
set -e

REGISTRY="${REGISTRY:-ghcr.io/ilw8}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"
STACK_NAME="${STACK_NAME:-osu-proxy}"

usage() {
    echo "Usage: $0 [entry|worker|monitoring|all]"
    echo ""
    echo "  entry       Build and update the entry proxy service"
    echo "  worker      Build and update the worker proxy service"
    echo "  monitoring  Update the monitoring stack (Prometheus + Grafana)"
    echo "  all         Build and update everything"
    echo ""
    echo "Environment variables:"
    echo "  REGISTRY    Container registry prefix (default: ghcr.io/ilw8)"
    echo "  PLATFORM    Build platforms (default: linux/amd64,linux/arm64)"
    echo "  STACK_NAME  Swarm stack name (default: osu-proxy)"
    exit 1
}

build_entry() {
    echo "==> Building entry image..."
    docker buildx build --platform "$PLATFORM" \
        -t "$REGISTRY/osu-proxy-entry:latest" --push ./entry
}

build_worker() {
    echo "==> Building worker image..."
    docker buildx build --platform "$PLATFORM" \
        -t "$REGISTRY/osu-proxy-worker:latest" --push ./worker
}

update_entry() {
    echo "==> Updating entry service..."
    docker service update --with-registry-auth --force --image "$REGISTRY/osu-proxy-entry:latest" "${STACK_NAME}_entry"
}

update_worker() {
    echo "==> Updating worker service..."
    docker service update --with-registry-auth --force --image "$REGISTRY/osu-proxy-worker:latest" "${STACK_NAME}_worker"
}

update_monitoring() {
    echo "==> Recreating monitoring stack..."
    docker stack rm osu-monitoring 2>/dev/null || true
    # Wait for services to drain before redeploying
    echo "==> Waiting for old services to stop..."
    while docker stack ps osu-monitoring >/dev/null 2>&1; do sleep 1; done
    docker stack deploy -c monitoring/stack.yml osu-monitoring
}

case "${1:-}" in
    entry)
        build_entry
        update_entry
        ;;
    worker)
        build_worker
        update_worker
        ;;
    monitoring)
        update_monitoring
        ;;
    all)
        build_entry
        build_worker
        update_entry
        update_worker
        update_monitoring
        ;;
    *)
        usage
        ;;
esac

echo "==> Done."
