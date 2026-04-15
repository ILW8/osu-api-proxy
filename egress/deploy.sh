#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/.env" 2>/dev/null || true

REGISTRY="${REGISTRY:-localhost:5000}"
STACK_NAME="osu-proxy"
PLATFORMS="linux/amd64,linux/arm64"

build_and_push() {
  local service="$1"
  local dir="$SCRIPT_DIR/$service"

  echo "==> Building $service..."
  docker buildx build \
    --platform "$PLATFORMS" \
    --tag "$REGISTRY/osu-proxy-$service:latest" \
    --push \
    "$dir"
}

deploy_stack() {
  echo "==> Deploying stack..."
  REGISTRY="$REGISTRY" docker stack deploy \
    -c "$SCRIPT_DIR/stack.yml" \
    "$STACK_NAME" \
    --with-registry-auth
}

update_service() {
  local service="$1"
  echo "==> Force-updating ${STACK_NAME}_${service}..."
  docker service update \
    --force \
    --with-registry-auth \
    "${STACK_NAME}_${service}"
}

rotate_users() {
  local map_file="${1:?Usage: deploy.sh users <path-to-users.json>}"
  local secret_name="users_json"
  local new_secret="${secret_name}_$(date +%s)"

  echo "==> Creating new secret $new_secret from $map_file..."
  docker secret create "$new_secret" "$map_file"

  echo "==> Updating entry service to use $new_secret..."
  docker service update \
    --secret-rm "$secret_name" \
    --secret-add "source=$new_secret,target=$secret_name" \
    "${STACK_NAME}_entry"

  echo "==> Done. Old secret can be removed manually."
}

case "${1:-}" in
  entry)   build_and_push entry && update_service entry ;;
  worker)  build_and_push worker && update_service worker ;;
  all)     build_and_push entry && build_and_push worker && deploy_stack ;;
  deploy)  deploy_stack ;;
  users)   rotate_users "${2:-}" ;;
  *)
    echo "Usage: $0 {entry|worker|all|deploy|users <path>}"
    echo ""
    echo "  entry   - Build + deploy entry proxy"
    echo "  worker  - Build + deploy worker proxy"
    echo "  all     - Build both + deploy stack"
    echo "  deploy  - Deploy stack (no build)"
    echo "  users   - Rotate users.json secret"
    exit 1
    ;;
esac
