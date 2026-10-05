"""Configuração do servidor MCP (variáveis de ambiente; nada de segredo em arquivo versionado)."""
from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from centralops_agent_contract.legacy_env import adopt_legacy_env

adopt_legacy_env()           # deploys ainda com SIE_* (nome antigo do produto) continuam funcionando


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CENTRALOPS_", env_file=".env", extra="ignore")

    # Conexão como a role `agent_rpc`: só EXECUTE em agent.* e nenhum acesso a tabelas (ver migration agent_rpcs)
    agent_database_url: str = "postgresql://agent_rpc:agent_rpc@127.0.0.1:55322/postgres"
    db_pool_max: int = 5
    # HS256 do token de contexto — o MESMO segredo do roteador (worker)
    agent_ctx_secret: str = Field(default="", description="obrigatório")
    # Chave que o Hermes envia como `Authorization: Bearer ...` (rede Docker interna; nunca exposto na internet)
    mcp_key: str = Field(default="", description="obrigatório")
    mcp_host: str = "0.0.0.0"
    mcp_port: int = 8000
    mcp_path: str = "/mcp"
    # Hosts aceitos no cabeçalho Host (proteção contra DNS rebinding); vazio desliga a checagem (a chave já protege a rede interna)
    mcp_allowed_hosts: list[str] = Field(default_factory=list)
    log_level: str = "INFO"

    def require_secrets(self) -> None:
        missing = [n for n, v in (("CENTRALOPS_AGENT_CTX_SECRET", self.agent_ctx_secret), ("CENTRALOPS_MCP_KEY", self.mcp_key)) if len(v) < 16]
        if missing:
            raise SystemExit(f"Configure {', '.join(missing)} (mínimo 16 caracteres) antes de subir o servidor MCP.")


def get_settings() -> Settings:
    return Settings()
