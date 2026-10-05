"""centralops-migrate contra o Postgres local: confere pendências, aplica uma migration nova uma única vez e grava na tabela do Supabase CLI."""
from __future__ import annotations

import shutil
from pathlib import Path

import psycopg
import pytest

from centralops_worker import migrate

from .conftest import DB_URL

pytestmark = pytest.mark.db
REPO = Path(__file__).resolve().parents[3]
VERSION = "99990101000000"


@pytest.fixture
def fake_supabase(tmp_path: Path):
    base = tmp_path / "supabase"
    shutil.copytree(REPO / "supabase" / "migrations", base / "migrations")
    (base / "seed").mkdir()
    shutil.copy(REPO / "supabase" / "seed" / "08_initial_admin.sql", base / "seed")
    (base / "migrations" / f"{VERSION}_centralops_migrate_test.sql").write_text(
        "create schema zz_migrate_test;\ncreate table zz_migrate_test.t (id int);\ninsert into zz_migrate_test.t values (1);\n", encoding="utf-8")
    yield base
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute("drop schema if exists zz_migrate_test cascade")
        conn.execute("delete from supabase_migrations.schema_migrations where version = %s", (VERSION,))


def test_repo_migrations_are_all_applied_locally():
    assert migrate.apply(DB_URL, REPO / "supabase", check_only=True) == 0


def test_applies_pending_once_and_records_it(fake_supabase: Path):
    assert migrate.apply(DB_URL, fake_supabase, check_only=True) == 2
    assert migrate.apply(DB_URL, fake_supabase) == 0
    with psycopg.connect(DB_URL) as conn:
        assert conn.execute("select count(*) from zz_migrate_test.t").fetchone()[0] == 1
        row = conn.execute("select name from supabase_migrations.schema_migrations where version = %s", (VERSION,)).fetchone()
        assert row == ("centralops_migrate_test",)
    assert migrate.apply(DB_URL, fake_supabase) == 0  # segunda vez: nada pendente, não reaplica
    with psycopg.connect(DB_URL) as conn:
        assert conn.execute("select count(*) from zz_migrate_test.t").fetchone()[0] == 1


def test_failed_migration_is_rolled_back_and_not_recorded(fake_supabase: Path):
    (fake_supabase / "migrations" / f"{VERSION}_centralops_migrate_test.sql").write_text(
        "create schema zz_migrate_test;\nselect 1/0;\n", encoding="utf-8")
    with pytest.raises(psycopg.Error):
        migrate.apply(DB_URL, fake_supabase)
    with psycopg.connect(DB_URL) as conn:
        assert conn.execute("select count(*) from pg_namespace where nspname = 'zz_migrate_test'").fetchone()[0] == 0
        assert conn.execute("select count(*) from supabase_migrations.schema_migrations where version = %s", (VERSION,)).fetchone()[0] == 0
