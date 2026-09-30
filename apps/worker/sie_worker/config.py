"""Configuração do worker (variáveis de ambiente; nada de segredo em arquivo versionado)."""
from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SIE_", env_file=".env", extra="ignore")

    # Postgres (Supabase). Em produção: conexão de serviço (pooler em modo sessão) — o worker é o único cliente privilegiado.
    database_url: str = "postgresql://postgres:postgres@127.0.0.1:55322/postgres"
    db_pool_min: int = 1
    db_pool_max: int = 10

    # Filas consumidas por este processo (vazio = todas)
    queues: list[str] = Field(default_factory=list)
    poll_interval_s: float = 1.0
    visibility_timeout_s: int = 60
    batch_size: int = 10
    max_attempts: int = 5                    # depois disso a mensagem vai para a DLQ
    concurrency: int = 5

    # Meta (WhatsApp Cloud API / Instagram)
    graph_api_base: str = "https://graph.facebook.com/v21.0"
    # Telegram
    telegram_api_base: str = "https://api.telegram.org"
    # Focus NFe
    focus_api_base: str = "https://homologacao.focusnfe.com.br"
    focus_token: str = ""

    # IA
    openrouter_base: str = "https://openrouter.ai/api/v1"
    openrouter_key: str = ""
    hermes_base: str = "http://hermes:8642/v1"
    hermes_key: str = ""
    agent_ctx_secret: str = "dev-only-change-me"          # HS256 do token de contexto (compartilhado com o MCP)
    ai_max_replies_per_hour: int = 12
    autopilot_min_confidence: float = 0.75
    router_debounce_s: int = 6

    # Áudio (Whisper via Groq)
    groq_base: str = "https://api.groq.com/openai/v1"
    groq_key: str = ""

    # Supabase Storage (mídia baixada da Meta)
    supabase_url: str = "http://127.0.0.1:55321"
    supabase_service_key: str = ""
    media_bucket: str = "omni-media"

    log_level: str = "INFO"


def get_settings() -> Settings:
    return Settings()
