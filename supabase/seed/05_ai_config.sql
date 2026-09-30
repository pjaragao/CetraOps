-- =====================================================================
-- Seed de CONFIGURAÇÃO da IA (idempotente): o que a ferramenta get_policies devolve à IA.
-- Enquanto os sócios não confirmarem (decisão pendente nº 11 do plano), o texto fica marcado como RASCUNHO.
-- =====================================================================

insert into core.settings (org_id, key, value) values ('00000000-0000-4000-8000-000000000001', 'policies', jsonb_build_object(
  'troca', jsonb_build_object('status', 'RASCUNHO — confirmar com os sócios', 'arrependimento', 'Compras remotas: 7 dias corridos do recebimento (CDC art. 49).',
    'tamanho', 'Trocas por tamanho/modelagem em até 30 dias com etiqueta e sem uso; a troca vira vale-troca.', 'defeito', 'Defeito de fabricação: encaminhar para atendimento humano.'),
  'pagamento', jsonb_build_object('status', 'RASCUNHO — confirmar com os sócios', 'formas', 'Pix, cartão de crédito em até 6x sem juros no link, débito.', 'confirmacao', 'O pedido só é separado depois da confirmação do pagamento.'),
  'entrega', jsonb_build_object('status', 'RASCUNHO — confirmar com os sócios', 'motoboy', 'Motoboy na região da loja; frete informado antes do pagamento.', 'retirada', 'Retirada na loja ou no Armário VIP sem custo.'),
  'desconto', jsonb_build_object('status', 'RASCUNHO', 'regra', 'A IA não concede desconto: só aplica cupom válido informado pela cliente.')))
on conflict (org_id, key) do nothing;
