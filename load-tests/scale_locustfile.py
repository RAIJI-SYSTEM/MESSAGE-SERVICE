"""Locust — comparativo 1×N do MESSAGE-SERVICE (chat).

Cada usuário escolhe uma réplica de ``RAIJI_SCALE_URLS``; o nome da requisição
inclui a réplica (porta) para o relatório separar por instância.

Por padrão exercita ``/health`` (sem autenticação). Para carga real em rotas
protegidas, defina ``RAIJI_SCALE_TOKEN`` (JWT) e ``RAIJI_SCALE_PATH``
(ex.: ``/conversations?limit=50``).

Uso: `./run-scale.sh` (ver run-scale.sh).
"""

from __future__ import annotations

import os
import random

from locust import HttpUser, between, task

URLS = [u.strip().rstrip("/") for u in os.getenv("RAIJI_SCALE_URLS", "http://127.0.0.1:3101").split(",") if u.strip()]
TOKEN = os.getenv("RAIJI_SCALE_TOKEN", "").strip()
PATH = os.getenv("RAIJI_SCALE_PATH", "/health").strip()
WAIT_MIN = float(os.getenv("RAIJI_SCALE_WAIT_MIN", "0.05"))
WAIT_MAX = float(os.getenv("RAIJI_SCALE_WAIT_MAX", "0.2"))


class ChatScaleUser(HttpUser):
    """Mesma carga por usuário em qualquer configuração (1×N)."""

    host = URLS[0] if URLS else ""
    wait_time = between(WAIT_MIN, WAIT_MAX)

    def on_start(self) -> None:
        self.base = random.choice(URLS)
        self.instance = self.base.rsplit(":", 1)[-1]
        self.headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}

    @task(8)
    def health(self) -> None:
        self.client.get(f"{self.base}/health", name=f"chat[{self.instance}] GET /health")

    @task(2)
    def read_route(self) -> None:
        if not TOKEN:
            return
        self.client.get(f"{self.base}{PATH}", name=f"chat[{self.instance}] GET {PATH}", headers=self.headers)
