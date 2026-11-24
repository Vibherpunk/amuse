#!/usr/bin/env bash
set -euo pipefail

AMUSE_DIR="/Users/ai/amuse"
ENV_FILE="${AMUSE_DIR}/.env"
MODELS_DIR="/Users/ai/models/omlx"
OMLX_URL="http://127.0.0.1:8000"
AMUSE_URL="http://127.0.0.1:3001"

usage() {
  cat <<'EOF'
Usage: amuse-model <command|alias>

Commands / Aliases:
  status                    Show current Amuse .env model settings and oMLX/Amuse health (default)
  3.8 | 27b | dense         Switch Amuse to Qwen3.8-27B-oQ4e-mtp
  3.6 | 35b | moe           Switch Amuse to Qwen3.6-35B-A3B-oQ3e-mtp
  -h | --help | help        Show this help message
EOF
}

show_status() {
  echo "=== Amuse .env (non-secret model config) ==="
  if [[ -f "${ENV_FILE}" ]]; then
    grep -E '^(AMUSE_AGENT_MODEL|AMUSE_FAST_MODEL|AMUSE_REASONING_EFFORT)=' "${ENV_FILE}" || true
  else
    echo "Missing ${ENV_FILE}" >&2
  fi

  echo ""
  echo "=== Amuse Health (${AMUSE_URL}/api/healthz) ==="
  local amuse_health
  if amuse_health=$(curl -fsS --max-time 3 "${AMUSE_URL}/api/healthz" 2>/dev/null); then
    echo "${amuse_health}"
  else
    echo "UNREACHABLE"
  fi

  echo ""
  echo "=== oMLX Status (${OMLX_URL}) ==="
  local omlx_health omlx_models
  omlx_health=$(curl -fsS --max-time 3 "${OMLX_URL}/health" 2>/dev/null || true)
  omlx_models=$(curl -fsS --max-time 3 "${OMLX_URL}/v1/models" 2>/dev/null || true)

  if [[ -n "${omlx_health}" ]]; then
    python3 - "${omlx_health}" "${omlx_models}" <<'PY'
import json
import sys

health = json.loads(sys.argv[1])
pool = health.get("engine_pool", {})
mem_bytes = pool.get("current_model_memory") or 0
mem_gib = mem_bytes / (1024 ** 3)
print(
    f"status={health.get('status')} "
    f"default_model={health.get('default_model')} "
    f"loaded_count={pool.get('loaded_count')} "
    f"current_model_memory={mem_gib:.2f} GiB"
)
if sys.argv[2]:
    models = json.loads(sys.argv[2]).get("data", [])
    ids = [m.get("id") for m in models if m.get("id")]
    print("available_models=" + ", ".join(ids))
else:
    print("available_models=UNAVAILABLE")
PY
  else
    echo "UNREACHABLE"
  fi
}

cmd="${1:-status}"

case "${cmd}" in
  status)
    show_status
    exit 0
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  3.8|27b|dense|Qwen3.8-27B-oQ4e-mtp)
    TARGET_MODEL="Qwen3.8-27B-oQ4e-mtp"
    ;;
  3.6|35b|moe|Qwen3.6-35B-A3B-oQ3e-mtp)
    TARGET_MODEL="Qwen3.6-35B-A3B-oQ3e-mtp"
    ;;
  *)
    echo "Error: unknown model or command '${cmd}'" >&2
    usage >&2
    exit 1
    ;;
esac

if [[ ! -d "${MODELS_DIR}/${TARGET_MODEL}" ]]; then
  echo "Error: model directory not found: ${MODELS_DIR}/${TARGET_MODEL}" >&2
  exit 1
fi

models_json=$(curl -fsS --max-time 5 "${OMLX_URL}/v1/models" 2>/dev/null || true)
if [[ -z "${models_json}" ]]; then
  echo "Error: could not query ${OMLX_URL}/v1/models" >&2
  exit 1
fi

if ! python3 - "${TARGET_MODEL}" "${models_json}" <<'PY'
import json
import sys

target = sys.argv[1]
data = json.loads(sys.argv[2]).get("data", [])
ids = {m.get("id") for m in data}
if target not in ids:
    sys.exit(1)
PY
then
  echo "Error: '${TARGET_MODEL}' is not yet exposed by oMLX at ${OMLX_URL}/v1/models." >&2
  echo "oMLX may need a restart to discover the newly downloaded model." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: ${ENV_FILE} not found" >&2
  exit 1
fi

python3 - "${ENV_FILE}" "${TARGET_MODEL}" <<'PY'
import os
import stat
import sys
import tempfile

env_path = sys.argv[1]
target_model = sys.argv[2]
updates = {
    "AMUSE_AGENT_MODEL": target_model,
    "AMUSE_FAST_MODEL": target_model,
    "AMUSE_REASONING_EFFORT": "low",
}

st = os.stat(env_path)
with open(env_path, "r", encoding="utf-8") as f:
    lines = f.read().splitlines(keepends=True)

seen = set()
out_lines = []
for line in lines:
    replaced = False
    for key, val in updates.items():
        if line.startswith(f"{key}="):
            ending = "\n" if line.endswith("\n") else ""
            out_lines.append(f"{key}={val}{ending}")
            seen.add(key)
            replaced = True
            break
    if not replaced:
        out_lines.append(line)

if out_lines and not out_lines[-1].endswith("\n"):
    out_lines[-1] += "\n"

for key, val in updates.items():
    if key not in seen:
        out_lines.append(f"{key}={val}\n")

env_dir = os.path.dirname(env_path)
fd, tmp_path = tempfile.mkstemp(prefix=".env.tmp.", dir=env_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.writelines(out_lines)
    os.chmod(tmp_path, stat.S_IMODE(st.st_mode))
    os.replace(tmp_path, env_path)
except Exception:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
    raise
PY

echo "Updated Amuse .env -> ${TARGET_MODEL} (AMUSE_REASONING_EFFORT=low)"
cd "${AMUSE_DIR}"
docker compose up -d --no-build --force-recreate amuse

healthy=0
for _ in $(seq 1 15); do
  resp=$(curl -fsS --max-time 2 "${AMUSE_URL}/api/healthz" 2>/dev/null || true)
  if [[ "${resp}" == *'"status":"ok"'* ]]; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "${healthy}" -ne 1 ]]; then
  echo "Error: Amuse did not report {\"status\":\"ok\"} within 15s at ${AMUSE_URL}/api/healthz" >&2
  exit 1
fi

echo "Amuse switched to ${TARGET_MODEL} and is healthy ({\"status\":\"ok\"})."
