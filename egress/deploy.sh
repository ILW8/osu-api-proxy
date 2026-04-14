#!/bin/sh
set -e

REGISTRY="${REGISTRY:-ghcr.io/ilw8}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"
STACK_NAME="${STACK_NAME:-osu-proxy}"

usage() {
    echo "Usage: $0 [entry|worker|monitoring|users|all]"
    echo ""
    echo "  entry       Build and update the entry proxy service"
    echo "  worker      Build and update the worker proxy service"
    echo "  monitoring  Update the monitoring stack (Prometheus + Grafana)"
    echo "  users       Rotate the users.map Docker secret from ./users.map"
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

update_users() {
    echo "==> Rotating users_map secret..."

    # Create new secret with timestamped name
    new_name="users_map_$(date +%s)"
    docker secret create "$new_name" ./users.map

    # Find the current secret name (may be "users_map" or "users_map_<timestamp>")
    current_name=$(docker service inspect "${STACK_NAME}_entry" \
        --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{if eq .File.Name "users_map"}}{{.SecretName}}{{end}}{{end}}')

    if [ -z "$current_name" ]; then
        echo "ERROR: no users_map secret found on ${STACK_NAME}_entry" >&2
        docker secret rm "$new_name"
        exit 1
    fi

    # Atomic swap: remove old + add new in one update (container never lacks the secret)
    docker service update \
        --secret-rm "$current_name" \
        --secret-add "source=$new_name,target=users_map" \
        "${STACK_NAME}_entry"

    # Clean up old secret
    docker secret rm "$current_name" 2>/dev/null || true

    echo "==> Rotated: $current_name -> $new_name"
}

update_monitoring() {
    echo "==> Updating monitoring stack..."
    docker stack deploy --resolve-image always -c monitoring/stack.yml osu-monitoring
    docker service update --force osu-monitoring_prometheus
    docker service update --force osu-monitoring_grafana
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
    users)
        update_users
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
