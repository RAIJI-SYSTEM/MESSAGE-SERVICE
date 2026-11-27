#!/usr/bin/env bash
# Executa Vitest + cobertura, Stryker e Playwright, e centraliza os relatórios
# HTML em reports/testes/.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/reports/testes"
LOGS="$OUT/logs"
mkdir -p "$OUT" "$LOGS"
rm -rf "$OUT"/testes.html "$OUT"/summary.json "$OUT"/vitest.json "$OUT"/cobertura "$OUT"/mutacao "$OUT"/e2e
status=0

run_log() {
  local name="$1"; shift
  echo "→ $name"
  "$@" > "$LOGS/$name.log" 2>&1
  local rc=$?
  echo "  $name: exit $rc"
  [ "$rc" -ne 0 ] && status=1
  return 0
}

run_log "01-vitest-cobertura" \
  npx vitest run --coverage --reporter=json --outputFile="$OUT/vitest.json"

python3 "$ROOT/scripts/reporting/generate_vitest_report.py" "$OUT"

if [ -d "$ROOT/coverage" ]; then
  cp -r "$ROOT/coverage" "$OUT/cobertura"
fi

run_log "02-stryker-mutacao" npm run mutation

mkdir -p "$OUT/mutacao"
if [ -f "$ROOT/reports/mutation/mutation.html" ]; then
  cp "$ROOT/reports/mutation/mutation.html" "$OUT/mutacao/mutation.html"
fi

if curl -fsS --max-time 3 http://localhost:3000/ >/dev/null 2>&1; then
  if [ ! -d "$ROOT/e2e/node_modules" ]; then
    (cd "$ROOT/e2e" && npm install --no-audit --no-fund) > "$LOGS/e2e-install.log" 2>&1
  fi
  (cd "$ROOT/e2e" && npx playwright test --reporter=html) > "$LOGS/03-e2e-playwright.log" 2>&1
  e2e_rc=$?
  echo "  03-e2e-playwright: exit $e2e_rc"
  [ "$e2e_rc" -ne 0 ] && status=1
  [ -d "$ROOT/e2e/playwright-report" ] && python3 "$ROOT/scripts/reporting/publish_e2e_videos.py" "$ROOT"
else
  echo "  03-e2e-playwright: ignorado (API não está em http://localhost:8000)" > "$LOGS/03-e2e-playwright.log"
  echo "Suba a stack para executar o E2E." >> "$LOGS/03-e2e-playwright.log"
fi

python3 "$ROOT/scripts/reporting/build_index.py" "$OUT" vitest

# --- Locust: carga, mensageria e escalabilidade ------------------------------
if [ "${RUN_LOAD:-1}" = "1" ] && curl -fsS --max-time 3 http://localhost:8000/actuator/health >/dev/null 2>&1; then
  LOAD_DIR="$ROOT/load-tests"
  if [ ! -x "$LOAD_DIR/.venv/bin/locust" ]; then
    (cd "$LOAD_DIR" && ./run.sh deps) > "$LOGS/04-locust-deps.log" 2>&1 || status=1
  fi
  (cd "$LOAD_DIR" && LOAD_USERS="${LOAD_USERS:-3}" LOAD_SPAWN="${LOAD_SPAWN:-1}" SMOKE_HOLD="${SMOKE_HOLD:-5}" ./run.sh smoke) > "$LOGS/04-locust-carga.log" 2>&1 || status=1
  AMQP_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' raiji-rabbitmq 2>/dev/null || true)
  if [ -n "$AMQP_IP" ]; then
    (cd "$LOAD_DIR" && RAIJI_AMQP_URL="amqp://raiji:raiji123@${AMQP_IP}:5672/%2f" AMQP_USERS="${AMQP_USERS:-2}" AMQP_SPAWN=1 AMQP_HOLD="${AMQP_HOLD:-5}" ./run-messaging.sh smoke) > "$LOGS/04-locust-mensageria.log" 2>&1 || status=1
  fi
  (cd "$LOAD_DIR" && NETWORK="avxae-core-monolith_default" MONGO_URI="mongodb://mongo:27017/raiji" RABBIT_URI="amqp://raiji:raiji123@rabbitmq:5672" KEYCLOAK_ISSUER="http://keycloak:8080/realms/raiji" KEYCLOAK_JWKS_URL="http://keycloak:8080/realms/raiji/protocol/openid-connect/certs" N_LIST=1 USERS="${SCALE_USERS:-2}" HOLD="${SCALE_HOLD:-3}" ./run-scale.sh) > "$LOGS/04-locust-escala.log" 2>&1 || status=1
else
  echo "Locust ignorado: stack não está em http://localhost:8000" > "$LOGS/04-locust.log"
fi

python3 "$ROOT/scripts/reporting/organize_reports.py" "$ROOT" "message-service"

echo
echo "Relatórios em: $OUT/index.html"
exit "$status"
