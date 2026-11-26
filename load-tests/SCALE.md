# Escalabilidade (1×N) — MESSAGE-SERVICE

Compara 1 × N réplicas do chat com a **mesma carga por instância**, gravando os
resultados no Grafana (via `observability/exporter/results/scale.json`).

```bash
./run-scale.sh                 # N=1,2 · 40 usuários fixos
N_LIST="1 2 4" USERS_PER_INSTANCE=100 SPAWN=400 HOLD=20 PROCS=8 USE_IPS=1 \
  RAIJI_SCALE_WAIT_MIN=0 RAIJI_SCALE_WAIT_MAX=0.005 START_INFRA=1 \
  RAIJI_SCALE_RESULTS=../../AVXAE-CORE-MONOLITH/observability/exporter/results/scale.json \
  ./run-scale.sh
```

Variáveis:

| Variável | Efeito |
|---|---|
| `N_LIST` | configurações de N (ex.: `1 2 4`) |
| `USERS_PER_INSTANCE` | carga **por instância** (total = N × valor); padrão: `USERS` fixo |
| `PROCS` | processos Locust (`--processes`) para não limitar no gerador |
| `USE_IPS=1` | fala direto no IP do container (sem `docker-proxy`) |
| `RAIJI_SCALE_WAIT_MIN/MAX` | espera por usuário (0 = saturação) |
| `RAIJI_SCALE_TOKEN/PATH` | rota autenticada (ex.: `/conversations?limit=50`) |
| `START_INFRA=1` | sobe Mongo/Rabbit temporários na rede do compose |
| `RAIJI_SCALE_RESULTS` | JSON lido pelo probe-exporter/Grafana |

Saídas: `reports/scale-n<N>-<stamp>_{stats,failures}.csv` e `.html`; a tabela de
eficiência aparece no terminal e no dashboard **Raiji · Escalabilidade 1×N**.

Detalhes do método e do gargalo medido: `AVXAE-CORE-MONOLITH/observability/RELATORIO-ESCALABILIDADE.md`.
