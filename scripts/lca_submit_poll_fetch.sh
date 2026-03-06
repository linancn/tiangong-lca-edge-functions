#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required"
  exit 1
fi

BASE_URL="${BASE_URL:-http://127.0.0.1:54321/functions/v1}"
USER_JWT="${USER_JWT:-}"
USER_API_KEY="${USER_API_KEY:-}"
SCOPE="${SCOPE:-prod}"
PROCESS_INDEX="${PROCESS_INDEX:-0}"
AMOUNT="${AMOUNT:-1}"
TIMEOUT_SEC="${TIMEOUT_SEC:-120}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-1}"
IDEMPOTENCY_KEY="${IDEMPOTENCY_KEY:-lca-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"

if [[ -z "${USER_JWT}" && -z "${USER_API_KEY}" ]]; then
  echo "error: either USER_JWT or USER_API_KEY is required"
  echo "example(jwt): USER_JWT=... PROCESS_INDEX=0 ./scripts/lca_submit_poll_fetch.sh"
  echo "example(api_key): USER_API_KEY=... PROCESS_INDEX=0 ./scripts/lca_submit_poll_fetch.sh"
  exit 1
fi

if [[ -n "${USER_JWT}" && -n "${USER_API_KEY}" ]]; then
  echo "error: set only one of USER_JWT or USER_API_KEY"
  exit 1
fi

AUTH_BEARER="${USER_JWT:-$USER_API_KEY}"

ensure_json() {
  local raw="$1"
  local stage="$2"
  if ! echo "${raw}" | jq -e . >/dev/null 2>&1; then
    echo "error: ${stage} response is not valid JSON"
    echo "${raw}"
    exit 1
  fi
}

submit_payload="$(
  jq -n \
    --arg scope "${SCOPE}" \
    --argjson process_index "${PROCESS_INDEX}" \
    --argjson amount "${AMOUNT}" \
    '{
      scope: $scope,
      demand: {
        process_index: $process_index,
        amount: $amount
      },
      solve: {
        return_x: false,
        return_g: true,
        return_h: true
      },
      print_level: 0
    }'
)"

echo "== submit =="
submit_resp="$(
  curl -sS -X POST "${BASE_URL}/lca_solve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_BEARER}" \
    -H "X-Idempotency-Key: ${IDEMPOTENCY_KEY}" \
    --data "${submit_payload}"
)"
ensure_json "${submit_resp}" "submit"
echo "${submit_resp}" | jq .

mode="$(echo "${submit_resp}" | jq -r '.mode // empty')"
if [[ -z "${mode}" ]]; then
  echo "error: submit response has no mode"
  exit 1
fi

job_id=""
result_id=""

if [[ "${mode}" == "cache_hit" ]]; then
  result_id="$(echo "${submit_resp}" | jq -r '.result_id // empty')"
else
  job_id="$(echo "${submit_resp}" | jq -r '.job_id // empty')"
  if [[ -z "${job_id}" ]]; then
    echo "error: submit mode=${mode} but job_id missing"
    exit 1
  fi
fi

if [[ -n "${job_id}" ]]; then
  echo "== poll job =="
  start_ts="$(date +%s)"
  while true; do
    now_ts="$(date +%s)"
    elapsed="$((now_ts - start_ts))"
    if (( elapsed > TIMEOUT_SEC )); then
      echo "error: polling timeout (${TIMEOUT_SEC}s), job_id=${job_id}"
      exit 1
    fi

    job_resp="$(
      curl -sS -X POST "${BASE_URL}/lca_jobs" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${AUTH_BEARER}" \
        --data "$(jq -n --arg job_id "${job_id}" '{job_id: $job_id}')"
    )"
    ensure_json "${job_resp}" "job_poll"

    status="$(echo "${job_resp}" | jq -r '.status // empty')"
    if [[ -z "${status}" ]]; then
      echo "error: invalid job response"
      echo "${job_resp}" | jq .
      exit 1
    fi

    echo "job=${job_id} status=${status} elapsed=${elapsed}s"

    if [[ "${status}" == "completed" || "${status}" == "ready" ]]; then
      result_id="$(echo "${job_resp}" | jq -r '.result.result_id // empty')"
      echo "${job_resp}" | jq .
      break
    fi

    if [[ "${status}" == "failed" || "${status}" == "stale" ]]; then
      echo "error: job terminal with status=${status}"
      echo "${job_resp}" | jq .
      exit 2
    fi

    sleep "${POLL_INTERVAL_SEC}"
  done
fi

if [[ -z "${result_id}" ]]; then
  echo "error: no result_id found"
  exit 1
fi

echo "== fetch result =="
result_resp="$(
  curl -sS -X POST "${BASE_URL}/lca_results" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${AUTH_BEARER}" \
    --data "$(
      jq -n \
        --arg result_id "${result_id}" \
        '{result_id: $result_id}'
    )"
)"
ensure_json "${result_resp}" "result_fetch"
echo "${result_resp}" | jq .

echo "done: result_id=${result_id}"
