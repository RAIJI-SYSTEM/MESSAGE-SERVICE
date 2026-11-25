"""Chat (MESSAGE-SERVICE): inbox, conversa aberta (polling de 2,5s), envio e grupos.

O app real mantém polling agressivo: inbox a cada 10s e conversa aberta a cada
2,5s (2 requests por ciclo). Os pesos abaixo refletem esse uso — a maior parte
da carga de chat vem de LER, não de escrever.
"""

from __future__ import annotations

import random

from locust import between, tag, task

from raiji import config, flows
from raiji.auth import POOL, TOKENS
from raiji.base import RaijiBase

# Conversas conhecidas por usuário (por processo do Locust)
_conversations: dict[str, list[str]] = {}


class ChatInbox(RaijiBase):
    weight = 4
    wait_time = between(0.5, 2.0)

    def _known(self) -> list[str]:
        cached = _conversations.get(self.cred.username)
        if cached:
            return cached
        resp = self.chat(
            "GET", "/conversations", name="chat: GET /conversations", params={"limit": 100}
        )
        if not self.check_ok(resp):
            return []
        ids = [c["_id"] for c in resp.json()]
        if ids:
            _conversations[self.cred.username] = ids
        return ids

    @tag("read", "chat")
    @task(5)
    def inbox(self) -> None:
        # Header do app: GET /conversations?limit=100 a cada 10-30s
        resp = self.chat(
            "GET", "/conversations", name="chat: GET /conversations", params={"limit": 100}
        )
        self.check_ok(resp)

    @tag("read", "chat")
    @task(4)
    def open_conversation(self) -> None:
        ids = self._known()
        if not ids:
            return
        cid = random.choice(ids)
        # É o que a tela de conversa faz a cada 2,5s: detalhe + mensagens
        self.chat(
            "GET",
            f"/conversations/{cid}",
            name="chat: GET /conversations/{id}",
            ok=(200, 404),
        )
        resp = self.chat(
            "GET",
            f"/conversations/{cid}/messages",
            name="chat: GET /conversations/{id}/messages",
            ok=(200, 404),
            params={"limit": 100},
        )
        if resp.status_code != 200:
            return
        # Ler as mensagens já marca como lido no servidor; às vezes o app
        # confirma explicitamente (badge do header).
        if random.random() < 0.2:
            self.chat(
                "POST",
                f"/conversations/{cid}/read",
                name="chat: POST /conversations/{id}/read",
                ok=(204, 404),
            )

    @tag("read", "chat")
    @task(1)
    def members(self) -> None:
        ids = self._known()
        if not ids:
            return
        self.chat(
            "GET",
            f"/conversations/{random.choice(ids)}/members",
            name="chat: GET /conversations/{id}/members",
            ok=(200, 404),
            params={"limit": 50},
        )


class ChatSender(RaijiBase):
    weight = 2
    wait_time = between(1.0, 3.0)

    @tag("write", "chat")
    @task(3)
    def send_direct(self) -> None:
        if not config.ENABLE_WRITES:
            return
        cid = flows.open_direct(self)
        if not cid:
            return
        _conversations.setdefault(self.cred.username, []).append(cid)
        del _conversations[self.cred.username][-20:]
        flows.send_message(self, cid)
        flows.list_messages(self, cid)

    @tag("write", "chat")
    @task(2)
    def send_group(self) -> None:
        if not config.ENABLE_WRITES:
            return
        gid = flows.ensure_group(self)
        if not gid:
            return
        flows.send_message(self, gid)
        flows.list_messages(self, gid)


class ChatGroups(RaijiBase):
    weight = 1
    wait_time = between(1.0, 3.0)

    @tag("read", "chat")
    @task(3)
    def list_groups(self) -> None:
        resp = self.chat("GET", "/groups", name="chat: GET /groups", params={"limit": 50})
        self.check_ok(resp)

    @tag("read", "chat")
    @task(2)
    def group_detail(self) -> None:
        gid = flows.ensure_group(self)
        if not gid:
            return
        self.chat("GET", f"/groups/{gid}", name="chat: GET /groups/{id}", ok=(200, 404))

    @tag("write", "chat")
    @task(1)
    def create_group(self) -> None:
        if not config.ENABLE_WRITES:
            return
        members = [
            c.subject for c in POOL.all()
            if c.subject and c.username != self.cred.username
        ]
        if not members:
            return
        resp = self.chat(
            "POST",
            "/groups",
            name="chat: POST /groups",
            json={
                "name": f"Grupo {random.randint(1, 9999)}",
                "memberIds": random.sample(members, min(3, len(members))),
            },
        )
        if self.check_ok(resp):
            _conversations.setdefault(self.cred.username, []).append(resp.json()["_id"])

    @tag("read", "chat")
    @task(1)
    def users_me(self) -> None:
        # Garante/atualiza o cadastro do usuário no chat (token -> Mongo)
        self.check_ok(self.chat("GET", "/users/me", name="chat: GET /users/me"))


class ChatDirectJourney(RaijiBase):
    """Conversa direta com DOIS atores, sem depender do monolito.

    A abre a conversa com B, envia; B lê e responde; A confirma no inbox.
    Exercita resolução de membro, autorização por participante e lastMessage.
    """

    weight = 1
    wait_time = between(1.0, 3.0)

    def on_start(self) -> None:
        super().on_start()
        self.peer = flows.peer_credentials(self)

    @tag("write", "read", "chat", "journey")
    @task
    def talk(self) -> None:
        if not config.ENABLE_WRITES or not self.peer:
            return
        peer_token = TOKENS.get(self.client, self.peer)
        if not peer_token:
            return

        resp = self.chat(
            "POST",
            "/conversations/direct",
            name="chat: POST /conversations/direct",
            ok=(200, 201),
            json={"userId": self.peer.subject, "role": "passenger", "myRole": "passenger"},
        )
        if resp.status_code not in (200, 201):
            return
        cid = resp.json()["_id"]

        self.chat(
            "POST",
            f"/conversations/{cid}/messages",
            name="chat: POST /conversations/{id}/messages",
            ok=(201,),
            json={"text": "Oi! Mensagem do ator A."},
        )

        # B lê e responde usando o próprio token
        resp = self.chat_token(
            peer_token,
            "GET",
            f"/conversations/{cid}/messages",
            name="chat: GET /conversations/{id}/messages",
            params={"limit": 50},
        )
        if resp.status_code != 200:
            return

        self.chat_token(
            peer_token,
            "POST",
            f"/conversations/{cid}/messages",
            name="chat: POST /conversations/{id}/messages",
            ok=(201,),
            json={"text": "Resposta do ator B."},
        )

        # A volta ao inbox e confere que a conversa está lá
        self.chat("GET", "/conversations", name="chat: GET /conversations", params={"limit": 100})
