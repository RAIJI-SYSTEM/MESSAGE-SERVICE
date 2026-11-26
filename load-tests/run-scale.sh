#!/usr/bin/env bash
# =============================================================================
# Comparativo 1×N do MESSAGE-SERVICE (chat) com Locust + Grafana
#
# Sobe N réplicas do chat (containers), compartilhando o mesmo Mongo/Rabbit,
# executa a MESMA carga em cada configuração e grava os resultados para o
# probe-exporter (dashboard "Escalabilidade 1×N" no Grafana).
#
# Uso:
#   N_LIST="1 2 4" USERS=100 HOLD=60 ./run-scale.sh
#
# Variáveis principais:
#   START_INFRA=1        sobe Mongo/Rabbit temporários na rede do compose
#   NETWORK              rede (default avxae-core-monolith_default)
#   CHAT_IMAGE           imagem do chat (default avxae-core-monolith-chat:latest)
#   MONGO_URI/RABBIT_URI URIs vistos de dentro dos containers
#   RAIJI_SCALE_RESULTS  arquivo JSON lido pelo probe-exporter
#   RAIJI_SCALE_TOKEN    JWT (opcional) + RAIJI_SCALE_PATH (/health por padrão)
#   GRAFANA_URL/GRAFANA_AUTH  para criar annotations (default localhost:3300)
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE=$(pwd)
REPO=$(cd "$HERE/.." && pwd)

N_LIST="${N_LIST:-1 2}"
USERS="${USERS:-40}"
USERS_PER_INSTANCE="${USERS_PER_INSTANCE:-}"
SPAWN="${SPAWN:-5}"
HOLD="${HOLD:-20}"
PROCS="${PROCS:-1}"
# USE_IPS=1 evita o docker-proxy: fala direto no IP do container (só no host Linux)
USE_IPS="${USE_IPS:-0}"
BASE_PORT="${BASE_PORT:-3100}"
NETWORK="${NETWORK:-avxae-core-monolith_default}"
CHAT_IMAGE="${CHAT_IMAGE:-avxae-core-monolith-chat:latest}"
MONGO_URI="${MONGO_URI:-mongodb://raiji-scale-mongo:27017/raiji}"
RABBIT_URI="${RABBIT_URI:-amqp://raiji:raiji123@raiji-scale-rabbit:5672}"
KEYCLOAK_ISSUER="${KEYCLOAK_ISSUER:-http://localhost:8180/realms/raiji}"
KEYCLOAK_JWKS_URL="${KEYCLOAK_JWKS_URL:-http://localhost:8180/realms/raiji/protocol/openid-connect/certs}"
RESULTS_FILE="${RAIJI_SCALE_RESULTS:-$HERE/scale-results.json}"
START_INFRA="${START_INFRA:-0}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3300}"
GRAFANA_AUTH="${GRAFANA_AUTH:-admin:admin}"
ANNOTATE="${ANNOTATE:-1}"
STAMP=$(date +%Y%m%d-%H%M%S)
REPORTS=reports
mkdir -p "$REPORTS"

PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
LOCUST=.venv/bin/locust
[ -x "$LOCUST" ] || LOCUST="locust"
command -v "$LOCUST" >/dev/null 2>&1 || { echo "[!] Locust não instalado: ./run-messaging.sh deps (ou run.sh deps)"; exit 1; }

CHAT_CONTAINERS=()
INSTANCE_URLS=()
INFRA_STARTED=0

cleanup() {
  for name in "${CHAT_CONTAINERS[@]:-}"; do
    [ -n "$name" ] && docker rm -f "$name" >/dev/null 2>&1 || true
  done
  if [ "$INFRA_STARTED" = 1 ]; then
    docker rm -f raiji-scale-mongo raiji-scale-rabbit >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! docker image inspect "$CHAT_IMAGE" >/dev/null 2>&1; then
  echo "[i] construindo imagem $CHAT_IMAGE ..."
  docker build -t "$CHAT_IMAGE" "$REPO" || exit 1
fi

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create "$NETWORK" >/dev/null || exit 1
fi

if [ "$START_INFRA" = 1 ]; then
  docker rm -f raiji-scale-mongo raiji-scale-rabbit >/dev/null 2>&1 || true
  docker run -d --rm --name raiji-scale-mongo --network "$NETWORK" mongo:8 >/dev/null
  # --user 999:999 evita o erro de permissão do .erlang.cookie
  docker run -d --rm --name raiji-scale-rabbit --network "$NETWORK" --user 999:999 \
    -e RABBITMQ_DEFAULT_USER=raiji -e RABBITMQ_DEFAULT_PASS=raiji123 \
    rabbitmq:4.0-management-alpine >/dev/null
  INFRA_STARTED=1
  echo "[i] aguardando Mongo/Rabbit..."
  ready=0
  for _ in $(seq 1 90); do
    if docker exec raiji-scale-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 \
       && docker exec raiji-scale-rabbit rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 1
  done
  [ "$ready" = 1 ] || { echo "[!] Mongo/Rabbit não subiram"; exit 1; }
fi

start_instances() { # $1 = N
  local n=$1 i port name url ip
  CHAT_CONTAINERS=()
  INSTANCE_URLS=()
  for i in $(seq 1 "$n"); do
    port=$((BASE_PORT + i))
    name="raiji-scale-chat-$i"
    docker rm -f "$name" >/dev/null 2>&1 || true
    if [ "$USE_IPS" = 1 ]; then
      docker run -d --rm --name "$name" --network "$NETWORK" \
        -e PORT=3000 -e MONGODB_URI="$MONGO_URI" -e RABBITMQ_URI="$RABBIT_URI" \
        -e KEYCLOAK_ISSUER="$KEYCLOAK_ISSUER" -e KEYCLOAK_JWKS_URL="$KEYCLOAK_JWKS_URL" \
        "$CHAT_IMAGE" >/dev/null || return 1
      ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
      url="http://$ip:3000"
    else
      docker run -d --rm --name "$name" --network "$NETWORK" -p "127.0.0.1:$port:3000" \
        -e PORT=3000 -e MONGODB_URI="$MONGO_URI" -e RABBITMQ_URI="$RABBIT_URI" \
        -e KEYCLOAK_ISSUER="$KEYCLOAK_ISSUER" -e KEYCLOAK_JWKS_URL="$KEYCLOAK_JWKS_URL" \
        "$CHAT_IMAGE" >/dev/null || return 1
      url="http://127.0.0.1:$port"
    fi
    CHAT_CONTAINERS+=("$name")
    INSTANCE_URLS+=("$url")
  done
  for i in $(seq 1 "$n"); do
    url="${INSTANCE_URLS[$((i-1))]}"
    for _ in $(seq 1 60); do
      curl -sf "$url/health" >/dev/null 2>&1 && break
      sleep 1
    done
    if ! curl -sf "$url/health" >/dev/null 2>&1; then
      echo "[!] réplica $i ($url) não respondeu:"
      docker logs "raiji-scale-chat-$i" 2>&1 | tail -8
      return 1
    fi
  done
}

urls_for() {
  local out=""
  for url in "${INSTANCE_URLS[@]}"; do out+="$url,"; done
  printf '%s' "${out%,}"
}

annotate() {
  [ "$ANNOTATE" = 1 ] || return 0
  curl -sf -u "$GRAFANA_AUTH" -H 'Content-Type: application/json' \
    -X POST "$GRAFANA_URL/api/annotations" \
    -d "{\"text\":\"$1\",\"tags\":[\"raiji-scale\"]}" >/dev/null 2>&1 || true
}

echo "[i] resultados do comparativo: $RESULTS_FILE"
for n in $N_LIST; do
  echo
  start_instances "$n" || exit 1
  urls=$(urls_for "$n")
  if [ -n "$USERS_PER_INSTANCE" ]; then
    run_users=$((n * USERS_PER_INSTANCE)); mode="por instância ($USERS_PER_INSTANCE cada)"
  else
    run_users=$USERS; mode="carga fixa"
  fi
  echo "[i] ===== N=$n instância(s) · $run_users usuários ($mode) · ${HOLD}s ====="
  annotate "Início escala N=$n (users=$run_users, ${HOLD}s)"
  procs_args=()
  [ "$PROCS" -gt 1 ] && procs_args=(--processes "$PROCS" --master-bind-port "${MASTER_PORT:-5557}")
  RAIJI_SCALE_URLS="$urls" \
  RAIJI_SCALE_TOKEN="${RAIJI_SCALE_TOKEN:-}" \
  RAIJI_SCALE_PATH="${RAIJI_SCALE_PATH:-/health}" \
    "$LOCUST" -f scale_locustfile.py --headless --only-summary \
      --html "$REPORTS/scale-n$n-$STAMP.html" \
      --csv "$REPORTS/scale-n$n-$STAMP" \
      "${procs_args[@]}" -u "$run_users" -r "$SPAWN" -t "${HOLD}s"
  rc=$?
  annotate "Fim escala N=$n"
  csv="$REPORTS/scale-n$n-${STAMP}_stats.csv"
  if [ -f "$csv" ]; then
    "$PY" scale_report.py "$csv" "$n" "$RESULTS_FILE"
  else
    echo "[!] CSV não encontrado: $csv"
  fi
  for name in "${CHAT_CONTAINERS[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  CHAT_CONTAINERS=()
  [ "$rc" -eq 0 ] || echo "[i] Locust terminou com código $rc (veja $REPORTS)"
done

echo
echo "[ok] comparativo concluído."
echo "     Grafana: $GRAFANA_URL  →  dashboard 'Raiji · Escalabilidade 1×N'"
echo "     JSON:    $RESULTS_FILE"
