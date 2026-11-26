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
  [ -d "$ROOT/e2e/playwright-report" ] && cp -r "$ROOT/e2e/playwright-report" "$OUT/e2e"
else
  echo "  03-e2e-playwright: ignorado (API não está em http://localhost:8000)" > "$LOGS/03-e2e-playwright.log"
  echo "Suba a stack para executar o E2E." >> "$LOGS/03-e2e-playwright.log"
fi

python3 "$ROOT/scripts/reporting/build_index.py" "$OUT" vitest

echo
echo "Relatórios em: $OUT/index.html"
exit "$status"
