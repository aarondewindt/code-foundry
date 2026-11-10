#!/usr/bin/env bash
# Synthetic offline probe only. Run from this checkout on the Ubuntu Docker host.
set -euo pipefail
if [[ $(id -u) == 0 ]]; then
  echo 'Run as the non-root developer with existing Docker access.' >&2
  exit 1
fi
if ! command -v docker >/dev/null || ! docker info --format '{{.OSType}}' | grep -qx linux; then
  echo 'A reachable Linux Docker engine is required on the host; do not mount its socket in the devcontainer.' >&2
  exit 1
fi
a2_repo=$(pwd -P)
test -f "$a2_repo/docs/experiments/a2/restricted-boundary-probe.py"
a2_fixture=$(mktemp -d /tmp/code-foundry-a2-host.XXXXXX)
a2_uid=$(id -u)
a2_gid=$(id -g)
a2_container="code-foundry-a2-probe-$(basename "$a2_fixture")"
mkdir "$a2_fixture/task" "$a2_fixture/shared"
printf 'synthetic attachment\n' > "$a2_fixture/shared/attachment.txt"
cp "$a2_fixture/shared/attachment.txt" "$a2_fixture/original.txt"
printf 'Evidence directory: %s\nContainer: %s\n' "$a2_fixture" "$a2_container"
printf '%s\n' "$a2_container" > "$a2_fixture/container-name"
docker build --file .devcontainer/Dockerfile --iidfile "$a2_fixture/image-id" .devcontainer
a2_image=$(cat "$a2_fixture/image-id")
# Preserve the stopped container and all evidence for review, including on failure.
set +e
docker run --name "$a2_container" --pull=never --init \
  --label "code-foundry.synthetic-probe=$(basename "$a2_fixture")" \
  --user "$a2_uid:$a2_gid" --network none --ipc private \
  --read-only --cap-drop ALL --security-opt no-new-privileges=true \
  --cpus 2 --memory 4g --memory-swap 4g --pids-limit 128 --ulimit core=0 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777 \
  --mount "type=bind,source=$a2_fixture/task,target=/task" \
  --mount "type=bind,source=$a2_fixture/shared,target=/shared,readonly,bind-recursive=disabled" \
  --mount "type=bind,source=$a2_repo/docs/experiments/a2/restricted-boundary-probe.py,target=/probe.py,readonly" \
  --workdir /task "$a2_image" python3 /probe.py | tee "$a2_fixture/result.json"
a2_status=${PIPESTATUS[0]}
set -e
# Selected nonsecret fields only. Never save/publish a full inspect/env dump.
docker inspect --format '{"privileged":{{.HostConfig.Privileged}},"readOnlyRoot":{{.HostConfig.ReadonlyRootfs}},"network":{{json .HostConfig.NetworkMode}},"capDrop":{{json .HostConfig.CapDrop}},"securityOptions":{{json .HostConfig.SecurityOpt}},"apparmorProfile":{{json .AppArmorProfile}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}}}' "$a2_container" > "$a2_fixture/runtime.json"
cmp "$a2_fixture/original.txt" "$a2_fixture/shared/attachment.txt"
printf '\nRetained evidence: %s\n' "$a2_fixture"
printf 'Return result.json and runtime.json for review. An offline pass does not verify service gateways or PostgreSQL 18.\n'
exit "$a2_status"
