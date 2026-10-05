"""Transição do nome do produto: as variáveis de ambiente passaram de SIE_* para CENTRALOPS_*.

Enquanto o deploy (Coolify/.env) não for renomeado, cada SIE_X vira CENTRALOPS_X se esta ainda não existir — o valor novo sempre vence.
Remover este módulo depois que nenhum ambiente usar mais o prefixo antigo.
"""
from __future__ import annotations

import logging
import os

OLD, NEW = "SIE_", "CENTRALOPS_"


def adopt_legacy_env(environ: os._Environ[str] | dict[str, str] | None = None) -> list[str]:
    """Copia as variáveis antigas para os nomes novos (sem sobrescrever). Devolve os nomes novos preenchidos assim."""
    env = os.environ if environ is None else environ
    adopted = []
    for key in [k for k in env if k.startswith(OLD)]:
        new = NEW + key[len(OLD):]
        if new not in env:
            env[new] = env[key]
            adopted.append(new)
    if adopted:
        logging.getLogger("centralops").warning("variáveis com o prefixo antigo SIE_ em uso (%s): renomeie para CENTRALOPS_ no deploy", ", ".join(sorted(adopted)))
    return adopted
