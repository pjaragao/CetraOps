-- Mídia do atendimento (áudios, fotos, vídeos e documentos que as clientes mandam no WhatsApp).
-- O worker (fila media_processing) baixa da Meta — a URL de lá expira — e guarda aqui, em <org_id>/<conversa>/<mensagem>.<ext>.
-- O bucket nunca tinha sido criado: o upload falhava, a mensagem ia para a DLQ e o áudio nem era transcrito ("[áudio]" na inbox).
insert into storage.buckets (id, name, public, file_size_limit)
values ('omni-media', 'omni-media', false, 104857600)     -- 100 MB: vídeo/documento do WhatsApp chegam a isso
on conflict (id) do nothing;

-- Leitura (URL assinada na inbox): só quem atende, e só a pasta da própria empresa. Escrita: só o worker (chave de serviço).
drop policy if exists omni_media_read on storage.objects;
create policy omni_media_read on storage.objects for select to authenticated
  using (bucket_id = 'omni-media' and (storage.foldername(name))[1] = (select private.org_id())::text and (select private.has_perm('omni.read')));

-- Reprocessa o que ficou sem arquivo nos últimos 25 dias (a Meta guarda a mídia por ~30 dias): baixa, guarda e transcreve.
do $$
declare r record; i int := 0;
begin
  for r in
    select m.id, m.type, m.payload -> 'media' as media, ca.provider_account_id
      from omni.messages m join omni.channel_accounts ca on ca.id = m.channel_account_id
     where m.direction = 'IN' and m.media_path is null and ca.channel = 'WHATSAPP'
       and m.payload -> 'media' ->> 'id' is not null and m.created_at > now() - interval '25 days'
  loop
    perform private.enqueue('media_processing', jsonb_build_object('message_id', r.id, 'channel', 'WHATSAPP', 'provider_account_id', r.provider_account_id,
                                                                   'media', r.media, 'type', r.type, 'redrive', true), i / 10);
    i := i + 1;
  end loop;
end $$;
