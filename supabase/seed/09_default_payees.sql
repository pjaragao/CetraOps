-- Favorecidos padrão (tributos, encargos, concessionárias de SC, telefonia, Correios). Idempotente; ver a migration 20261005000500.
select private.seed_default_payees('00000000-0000-4000-8000-000000000001');
