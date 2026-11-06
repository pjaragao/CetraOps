-- Catálogo do site espalhado ao longo do dia (06/11/2026). Em 05/11 o siewear.com passou a responder 429 à leitura completa,
-- que fazia ~150 pedidos de uma vez às 05:20 (um por coleção). Agora o worker relê só 16 coleções por rodada (revezamento)
-- e o guia de tamanho 1× por dia, com 4 s entre pedidos: ~20 pedidos por rodada completa e 1 por rodada de preços.
-- Horários (UTC; Brasília = UTC−3), intercalados a cada 3 h:
--   completa: 01:45, 07:45, 13:45, 19:45 (Brasília 22:45, 04:45, 10:45, 16:45)
--   preços:   04:30, 10:30, 16:30, 22:30 (Brasília 01:30, 07:30, 13:30, 19:30)
do $$
declare r record;
begin
  for r in select j.jobname, j.command, x.sched
           from cron.job j join (values
             ('centralops-catalog-site-full', '45 1,7,13,19 * * *'),
             ('centralops-catalog-site-prices', '30 4,10,16,22 * * *')
           ) as x(jobname, sched) on x.jobname = j.jobname loop
    perform cron.unschedule(r.jobname);
    perform cron.schedule(r.jobname, r.sched, r.command);
  end loop;
end $$;
