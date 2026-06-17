#!/usr/bin/env bash
# ============================================================================
# verify-gpu.sh — one-shot health check for Dina's GPU inference path.
# Safe, read-only. Exit code 0 = healthy, 1 = degraded, 2 = broken.
# Usage:  bash ops/verify-gpu.sh
# ============================================================================
set -uo pipefail

OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
status=0

echo "──────────────────────────────────────────────"
echo " DINA GPU verification  ($(date -Is))"
echo "──────────────────────────────────────────────"

# 1) Driver / NVML --------------------------------------------------------------
echo
echo "1) nvidia-smi (driver / NVML):"
if smi="$(nvidia-smi 2>&1)"; then
  echo "$smi" | grep -E "Driver Version|GeForce|MiB /" || echo "$smi" | head -n 5
  echo "   ✅ NVML OK"
else
  echo "   🔴 nvidia-smi FAILED:"
  echo "$smi" | sed 's/^/      /'
  echo "   → Driver/library mismatch likely. REBOOT the host. See ops/GPU_RUNBOOK.md §1"
  exit 2
fi

# 2) Ollama reachability --------------------------------------------------------
echo
echo "2) Ollama daemon ($OLLAMA_URL):"
if ! ver="$(curl -fsS --max-time 5 "$OLLAMA_URL/api/version" 2>/dev/null)"; then
  echo "   🔴 Ollama unreachable. Try: sudo systemctl status ollama"
  exit 2
fi
echo "   ✅ $ver"

# 3) Loaded-model residency -----------------------------------------------------
echo
echo "3) Loaded models (GPU vs CPU residency):"
ps_json="$(curl -fsS --max-time 5 "$OLLAMA_URL/api/ps" 2>/dev/null)"

if command -v jq >/dev/null 2>&1 && [ -n "$ps_json" ]; then
  count="$(echo "$ps_json" | jq '.models | length')"
  if [ "$count" = "0" ]; then
    echo "   🟦 No models currently loaded (idle). Send one request, then re-run."
  else
    echo "$ps_json" | jq -r '.models[] | "   • \(.name): \(((.size_vram // 0) / (.size // 1) * 100) | floor)% GPU  (\(((.size_vram // 0)/1073741824)|.*100|round/100)GB / \(((.size // 0)/1073741824)|.*100|round/100)GB)"'
    cpu_models="$(echo "$ps_json" | jq -r '.models[] | select((.size_vram // 0) < (.size // 1) * 0.99) | .name')"
    if [ -n "$cpu_models" ]; then
      echo "   ⚠️  CPU offload detected for: $cpu_models"
      echo "   → If nvidia-smi is healthy: sudo systemctl restart ollama  (see RUNBOOK §2)"
      status=1
    else
      echo "   ✅ All loaded models are 100% on GPU"
    fi
  fi
else
  # Fallback without jq
  echo "$ps_json" | sed 's/^/   /'
  echo "   (install 'jq' for a parsed view)"
fi

echo
echo "──────────────────────────────────────────────"
[ "$status" = "0" ] && echo " RESULT: ✅ GPU path healthy" || echo " RESULT: ⚠️ degraded — see notes above"
echo "──────────────────────────────────────────────"
exit $status