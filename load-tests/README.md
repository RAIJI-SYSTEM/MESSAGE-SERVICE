# Testes de carga — Chat (MESSAGE-SERVICE)

Suíte [Locust](https://locust.io) autocontida (não altera nenhum arquivo do
projeto: só adiciona este diretório). Gera carga real autenticada, com métricas
separadas por serviço.

## O que é medido

Cobre o serviço de chat (Bun + Fastify + MongoDB) através do Kong em `/chat`:

| Classe | O que mede |
|---|---|
| `PublicEndpoints` / `TokenEndpoint` | saúde do Kong e login no Keycloak |
| `ChatInbox` | inbox (10–30 s), conversa aberta (polling de 2,5 s), membros, marcar lido |
| `ChatSender` | abre conversa direta, envia e lista mensagens |
| `ChatGroups` | lista/cria grupos, detalhe, `/users/me` |
| `ChatDirectJourney` | dois atores reais: A abre, envia; B lê e responde; A confirma no inbox |

O grupo da carona (`/conversations/by-ride/{rideId}`) nasce de um evento do
monolito no RabbitMQ; esse caminho é verificado pela suíte do monolito e pela
suíte combinada.

## Preparar (uma vez)

```bash
./run.sh deps      # cria .venv e instala o Locust
./run.sh seed      # 50 passageiros + 20 motoristas no Keycloak (users.csv)
./run.sh check     # confere Kong, Keycloak, chat, front, roles e dados
```

## Rodar

```bash
./run.sh smoke     # 5 usuários, 1 min  — valida os fluxos
./run.sh load      # 100 usuários, rampa 60 s + 6 min
./run.sh stress    # degraus de 50 em 50 até 800
./run.sh spike     # 400 usuários em 10 s
./run.sh soak      # 50 usuários por 1 h
./run.sh read      # só leitura
./run.sh web       # UI em http://localhost:8089
```

Recortes por tag (sem a UI):

```bash
DURATION=120 LOAD_USERS=40 ./run.sh <comando>
```

Cada execução grava `reports/<perfil>-<timestamp>.html` e `.csv`.

## Variáveis úteis

| Variável | Para quê |
|---|---|
| `LOAD_USERS` / `LOAD_SPAWN` / `LOAD_HOLD` | tamanho e duração da carga |
| `DURATION` | segundos nos recortes (`api`, `chat`, `front`, `journey`, `read`) |
| `RAIJI_ENABLE_WRITES=false` | só leitura (não cria caronas/mensagens) |
| `RAIJI_GATEWAY` | endereço do Kong (default `http://localhost:8000`) |
| `RAIJI_HTTP_TIMEOUT` | timeout por requisição (default 20 s) |

As flags de escopo (`RAIJI_MONOLITH_ENABLED`, `RAIJI_CHAT_ENABLED`,
`RAIJI_FRONT_ENABLED`) vêm no `.env` desta suíte e desligam o que não pertence a
ela.

## Testar tudo junto

A visão combinada (monolito + chat + front em um único relatório) fica fora dos
repositórios, em `~/Documentos/integrador-raiji/load-tests`:

```bash
cd ~/Documentos/integrador-raiji/load-tests
./run.sh load             # um processo Locust misturando todas as classes
./run-all-suites.sh load  # três processos em paralelo, um por repositório
```

## Ler o resultado

- Prefixos por serviço: `public:` (Kong), `auth:` (Keycloak), `api:` (monolito),
  `chat:` (MESSAGE-SERVICE), `front:` / `front(bff):` (Next).
- 404/409 esperados do domínio não contam como falha (cada chamada declara os
  códigos aceitos); 401/403 em massa indicam token/role — rode `./run.sh seed`.
- Compare `api:` com `front(bff):` para o mesmo endpoint: a diferença é o custo
  do proxy do Next.


## Mensageria (AMQP)

Testa a **ingestão** de eventos no chat (o que o monolito e o Keycloak
publicam), além da ida e volta no exchange `raiji.chat`. Locust não fala AMQP
nativamente: a suíte usa `pika` e publica as métricas como `request_type=AMQP`,
nos mesmos relatórios de `reports/`.

```bash
./run-messaging.sh deps          # instala Locust + pika
./run-messaging.sh smoke         # 5 VUs, 20 s (ingest + probe)
./run-messaging.sh load          # 30 VUs, rampa 3/s, 120 s
./run-messaging.sh ride          # só ride.created/synced/finished/participant
./run-messaging.sh user          # só user.created/user.deleted
./run-messaging.sh egress        # só message.created (push)
./run-messaging.sh probe         # só ida e volta no raiji.chat
```

- `publish ride.*` → exchange `raiji.rides` (grupos do chat);
- `publish user.*` → exchange `raiji.users` (ciclo de vida do usuário);
- `publish message.created` → exchange `raiji.chat` (push no monolito);
- `consume raiji.chat (probe)` → latência de ida e volta no broker.

O probe usa `RAIJI_AMQP_PROBE_ROUTING_KEY=loadtest.probe` por padrão para não
acordar o monolito; defina `message.created` para exercitar o caminho real.
Isto mede **vazão e latência**: contrato, DLQ e retry continuam nos testes
funcionais (Vitest/JUnit).
