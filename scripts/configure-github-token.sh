#!/usr/bin/env bash
# Local preparation only: encrypted Secret + Flux resource reference. Never applies, commits or pushes.
set +x
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
homelab=${1:-"${HOMELAB_REPO:-$(dirname "$root")/homelab}"}
for tool in kubectl sops python3; do command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }; done
resources="$homelab/apps/kaeno/kustomization.yaml"
test -f "$resources" && test -f "$homelab/.sops.yaml" || { echo 'Expected a homelab checkout with apps/kaeno and .sops.yaml' >&2; exit 1; }

read -r -s -p 'Fine-grained GitHub PAT (hidden): ' token </dev/tty
printf '\n' >/dev/tty
test -n "$token" || { echo 'Token cannot be empty' >&2; exit 1; }
output="$homelab/apps/kaeno/github-api.secret.enc.yaml"
staging=$(mktemp "$homelab/apps/kaeno/.github-api.secret.enc.XXXXXX")
trap 'rm -f "$staging"; unset token' EXIT
# No token in command arguments, environment, plaintext files or terminal output.
printf '%s' "$token" |
  kubectl -n kaeno create secret generic kaeno-github-api --from-file=token=/dev/stdin --dry-run=client -o yaml |
  (cd "$homelab" && sops --encrypt --input-type yaml --output-type yaml --filename-override apps/kaeno/github-api.secret.enc.yaml /dev/stdin) >"$staging"
unset token
mv "$staging" "$output"
python3 - "$resources" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
entry = '  - github-api.secret.enc.yaml\n'
if entry not in text:
    anchor = '  - github-ssh.secret.enc.yaml\n'
    if anchor not in text:
        raise SystemExit('Cannot locate GitHub Secret resource; add github-api.secret.enc.yaml manually')
    path.write_text(text.replace(anchor, anchor + entry, 1))
PY
printf 'Prepared encrypted Secret and resource reference in %s. Review and push when ready; nothing was applied.\n' "$homelab"
