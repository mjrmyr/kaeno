#!/usr/bin/env bash
# In-cluster WORK smoke test for the Kubernetes backend (optionally under Kata).
#
# Usage: KAENO_K3S_SSH=user@node scripts/kubernetes-smoke.sh [backend-config-file]
#
#   KAENO_K3S_SSH         SSH target of a k3s node; the image is imported there
#                         with `k3s ctr images import`. Unset: skip the import
#                         (the image must already be pullable by the node).
#   KAENO_SKIP_BUILD=1    reuse the existing local kaeno:local image.
#   KAENO_PLATFORM        build platform, default linux/amd64.
#   KAENO_HOST_SERVICE_ACCOUNT
#                         host service account, default kaeno-kubernetes-host.
#
# Uses the current kubectl context. Never point it at an active application's
# owner: the smoke test reconciles (deletes) that owner's sandbox pods.
set -euo pipefail
cd "$(dirname "$0")/.."

namespace=kaeno
config=${1:-kubernetes.config.example.json}
image=kaeno:local
host_account=${KAENO_HOST_SERVICE_ACCOUNT:-kaeno-kubernetes-host}

echo "kubectl context: $(kubectl config current-context)"

if [[ ${KAENO_SKIP_BUILD:-} != 1 ]]; then
  docker buildx build --platform "${KAENO_PLATFORM:-linux/amd64}" \
    --tag "$image" --load .
fi
if [[ -n ${KAENO_K3S_SSH:-} ]]; then
  docker save "$image" | ssh "$KAENO_K3S_SSH" sudo k3s ctr images import -
fi

missing=0
# NetworkPolicy layouts vary per cluster, so only the objects Kaeno names are checked.
for resource in "serviceaccount/$host_account" serviceaccount/kaeno-sandbox \
  service/kaeno-sandbox resourcequota/kaeno-sandbox; do
  kubectl -n "$namespace" get "$resource" >/dev/null 2>&1 || {
    echo "missing $namespace/$resource" >&2
    missing=1
  }
done
if ((missing)); then
  echo "Create the namespace and apply src/extensions/kubernetes/cluster.yaml first:" >&2
  echo "  kubectl create namespace $namespace" >&2
  echo "  kubectl apply -f src/extensions/kubernetes/cluster.yaml" >&2
  exit 1
fi

kubectl -n "$namespace" create configmap kaeno-smoke \
  --from-file=work-smoke.ts=scripts/work-smoke.ts \
  --from-file=kubernetes.json="$config" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" delete job kaeno-smoke --ignore-not-found --wait
sed "s/serviceAccountName: kaeno-kubernetes-host/serviceAccountName: $host_account/" \
  scripts/kubernetes-smoke.yaml | kubectl apply -f -

# Poll rather than `kubectl wait`, so a brief API outage (k3s restarts) does not abort the run.
deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
  status=$(kubectl -n "$namespace" get job kaeno-smoke \
    -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || true)
  case $status in
  1/*) result=0 && break ;;
  */1) result=1 && break ;;
  esac
  sleep 5
done
kubectl -n "$namespace" logs job/kaeno-smoke || true
if [[ ${result:-1} != 0 ]]; then
  echo "kaeno-smoke failed (job status: ${status:-unknown})" >&2
  kubectl -n "$namespace" describe job kaeno-smoke | tail -20 >&2 || true
  exit 1
fi
echo "kaeno-smoke passed"
