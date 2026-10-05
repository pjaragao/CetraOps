"""sie-migrate: confere o banco a cada deploy e aplica o que faltar, antes de o web e o worker subirem.

1. Migrations: compara `supabase/migrations/*.sql` com `supabase_migrations.schema_migrations` (a MESMA tabela do
   `supabase db push`, então os dois caminhos convivem) e aplica as pendentes em ordem, cada uma numa transação.
2. Instalação nova (a empresa ainda não existe): roda os seeds de configuração `supabase/seed/0*.sql` (nunca os de dev, 9x).
3. Sempre: `seed/08_initial_admin.sql`, que garante um jeito de entrar (só age se não houver sócio ativo ou se a conta
   do administrador inicial estiver sem vínculo).

Um advisory lock impede dois deploys aplicando ao mesmo tempo. Qualquer erro aborta com código 1 e o deploy não sobe
versão nova sobre banco desatualizado. `sie-migrate --check` só lista o que falta (código 2 se houver pendência).
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from pathlib import Path

import psycopg

log = logging.getLogger("sie.migrate")

ORG_ID = "00000000-0000-4000-8000-000000000001"
LOCK_KEY = 7_311_002_026                    # advisory lock exclusivo do sie-migrate
VERSION_RE = re.compile(r"^(\d{14})_(.+)\.sql$")


def supabase_dir() -> Path:
    env = os.environ.get("SIE_SUPABASE_DIR")
    candidates = [Path(env)] if env else [Path("/repo/supabase"), *(d / "supabase" for d in [Path.cwd(), *Path.cwd().parents][:3])]
    for c in candidates:
        if (c / "migrations").is_dir():
            return c
    raise SystemExit(f"pasta supabase/migrations não encontrada (defina SIE_SUPABASE_DIR); procurei em: {', '.join(map(str, candidates))}")


def migration_files(base: Path) -> list[tuple[str, str, Path]]:
    out = []
    for f in sorted((base / "migrations").glob("*.sql")):
        m = VERSION_RE.match(f.name)
        if m:
            out.append((m.group(1), m.group(2), f))
    return out


def ensure_table(conn: psycopg.Connection) -> None:
    conn.execute("create schema if not exists supabase_migrations")
    conn.execute("create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)")


def applied_versions(conn: psycopg.Connection) -> set[str]:
    return {r[0] for r in conn.execute("select version from supabase_migrations.schema_migrations").fetchall()}


def pending(conn: psycopg.Connection, base: Path) -> list[tuple[str, str, Path]]:
    done = applied_versions(conn)
    return [m for m in migration_files(base) if m[0] not in done]


def run_sql_file(conn: psycopg.Connection, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    with conn.transaction():
        conn.execute(sql)  # sem parâmetros: vai pelo protocolo simples, que aceita vários comandos


def apply(dsn: str, base: Path, check_only: bool = False) -> int:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("select pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            ensure_table(conn)
            todo = pending(conn, base)
            if check_only:
                for version, name, _ in todo:
                    print(f"pendente: {version}_{name}")
                print("banco em dia" if not todo else f"{len(todo)} migration(s) pendente(s)")
                return 2 if todo else 0

            for version, name, path in todo:
                log.info("aplicando %s_%s", version, name)
                sql = path.read_text(encoding="utf-8")
                with conn.transaction():
                    conn.execute(sql)
                    conn.execute(
                        "insert into supabase_migrations.schema_migrations (version, name, statements) values (%s, %s, %s)",
                        (version, name, [sql]),
                    )
            log.info("migrations: %s aplicada(s); banco em dia", len(todo))

            seeds = base / "seed"
            fresh = conn.execute("select not exists (select 1 from core.orgs where id = %s)", (ORG_ID,)).fetchone()[0]
            if fresh:
                for f in sorted(seeds.glob("0*.sql")):
                    log.info("instalação nova: seed %s", f.name)
                    run_sql_file(conn, f)
            admin = seeds / "08_initial_admin.sql"
            if admin.exists():
                run_sql_file(conn, admin)
                log.info("administrador inicial conferido")
            return 0
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (LOCK_KEY,))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="sie-migrate", description="Aplica as migrations pendentes do SIÉ JOY OS.")
    parser.add_argument("--check", action="store_true", help="só lista as pendentes (sai com 2 se houver)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("SIE_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    dsn = os.environ.get("SIE_MIGRATE_DATABASE_URL") or os.environ.get("SIE_DATABASE_URL")
    if not dsn:
        # sem a variável não dá para conferir; não derruba o deploy inteiro por isso, mas avisa alto no log
        log.error("SIE_DATABASE_URL não definida: migrations NÃO conferidas. Defina-a (conexão como usuário postgres) no .env do deploy.")
        sys.exit(0)
    try:
        code = apply(dsn, supabase_dir(), check_only=args.check)
    except psycopg.Error as e:
        log.error("falha ao migrar: %s", e)
        sys.exit(1)
    sys.exit(code)


if __name__ == "__main__":
    main()
