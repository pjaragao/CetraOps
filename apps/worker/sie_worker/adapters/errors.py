"""Erros de integração classificados: o runner repete os transitórios e manda os permanentes para a DLQ/estado de falha."""
from __future__ import annotations


class IntegrationError(Exception):
    def __init__(self, message: str, *, code: str | int | None = None, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class TransientError(IntegrationError):
    """429, 5xx, timeout, rede: repetir com recuo."""

    def __init__(self, message: str, *, retry_after: int | None = None, **kw: object) -> None:
        super().__init__(message, **kw)  # type: ignore[arg-type]
        self.retry_after = retry_after


class PermanentError(IntegrationError):
    """Requisição inválida, destinatário inexistente, janela fechada, credencial inválida: repetir não resolve."""
