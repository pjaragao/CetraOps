# Mudança para o Supabase Cloud e backup

Roteiro para tirar o banco do homelab e levar para o Supabase Cloud (região São Paulo, `sa-east-1`), com o sistema num servidor online. O homelab fica intacto até o fim: se algo der errado, é só voltar a apontar para ele.

Tudo foi ensaiado em 12/10/2026 num Postgres descartável com a mesma imagem do Supabase e o usuário `postgres` sem superusuário, como no Cloud:

| Conferência | Resultado |
|---|---|
| Migrations aplicadas do zero | 108, sem erro |
| Dados copiados do homelab | 224 tabelas com contagens idênticas |
| Chave dos CPFs | copiada |
| Rotinas agendadas | 32 jobs |

---

## 1. Backup (já valendo no homelab)

| Peça | O que faz |
|---|---|
| `infra/scripts/backup-db.sh` | Dump diário. Inclui todos os schemas do sistema, os usuários do Auth, os metadados do Storage e o registro das migrations. Confere o arquivo e as tabelas principais e, opcionalmente, cifra (gpg AES-256) e copia para fora da máquina (rclone). Retenção: 14 diários e 12 mensais. |
| `infra/scripts/restore-check.sh` | Restaura o backup mais recente num contêiner descartável, nunca no banco de produção, e compara as contagens com a origem. Rodar **uma vez por mês** e depois da mudança. |

O homelab já tem o agendamento (crontab, todo dia às 02:30, origem `supabase-db`). O primeiro backup e o teste de restauração foram feitos em 12/10/2026 e as contagens bateram com a produção.

**Falta você fazer:**
- **Cópia fora da máquina.** Instale o rclone (`sudo apt install rclone`) e configure um destino (`rclone config`): Google Drive, Backblaze B2 ou Cloudflare R2. Depois acrescente na linha do crontab:
  - `CENTRALOPS_BACKUP_RCLONE=gdrive:centralops-backups`
  - `CENTRALOPS_BACKUP_PASSPHRASE_FILE=/home/paulojr/.centralops-backup.pass` (arquivo com a senha, `chmod 600`, com uma cópia no Vaultwarden)
- **Aviso de falha (opcional).** Crie um check gratuito no healthchecks.io e coloque a URL em `CENTRALOPS_HEARTBEAT_URL`. Se o backup não rodar ou falhar, chega um e-mail.

No servidor novo, a mesma linha troca a origem:
```bash
30 2 * * * CENTRALOPS_BACKUP_DB_URL='postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres' CENTRALOPS_BACKUP_RCLONE=gdrive:centralops-backups CENTRALOPS_BACKUP_PASSPHRASE_FILE=/root/.centralops-backup.pass /opt/centralops/infra/scripts/backup-db.sh >> /var/log/centralops-backup.log 2>&1
```

O plano Pro do Supabase guarda **7 dias de backup diário**, e a restauração a qualquer momento (PITR) é um adicional. O nosso backup é a cópia **fora do Supabase**: protege contra erro de conta, exclusão acidental e prazo maior.

> **Guarde no cofre de senhas (Vaultwarden):**
> - a chave `crm_cpf_key`;
> - as credenciais das integrações (provedor fiscal, Stone, Meta).
>
> Elas ficam cifradas no Vault com a chave do servidor e **não vão no backup**. Sem a chave, os CPFs restaurados em outro servidor não abrem.

---

## 2. Antes da mudança

1. **Implante a versão atual no homelab** (deploy no Coolify) para que ele rode as mesmas migrations do Cloud. O script se recusa a copiar se as versões forem diferentes, porque as permissões criadas por migrations novas se perderiam na cópia.
2. **Crie o projeto no Supabase:**
   - região **South America (São Paulo)**;
   - plano **Pro**;
   - anote o *project ref*, a senha do banco, a chave `anon` e a `service_role`.
3. **Ajuste o painel do Supabase:**
   - **Database › Extensions:** ligue `pg_cron`, `pgmq`, `pg_net`, `vector`, `pg_trgm` e `unaccent`.
   - **Settings › API › Exposed schemas:** `public, graphql_public, core, crm, catalog, inv, sales, fin, fiscal, omni, ai, mkt, aff, hr, purch`.
     - Inclua `mkt` e `aff`, que o `infra/README.md` antigo não lista.
     - **Não** exponha `private`, `agent` nem `audit`.
   - **Settings › API › Max rows:** pode ficar em 1.000. As telas que precisam da lista inteira (PDV, estoque, contagem, etiquetas) já leem em páginas.
   - **Authentication:**
     - desligue "Allow new users to sign up" (os usuários são criados em Configurações › Usuários);
     - em *Site URL*, coloque o domínio do sistema;
     - configure o SMTP próprio, porque o do Supabase tem limite baixo.
4. **Faça um backup do homelab:** `CENTRALOPS_BACKUP_CONTAINER=supabase-db infra/scripts/backup-db.sh`.

## 3. Mudança (ensaie num projeto de teste primeiro)

Use a **conexão direta** (`db.<ref>.supabase.co:5432`, usuário `postgres`). O pooler em modo transação não serve.

```bash
export TARGET_DB_URL='postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres'
infra/scripts/migrate-to-cloud.sh preflight   # acesso, extensões, se o destino aceita a carga com gatilhos desligados
infra/scripts/migrate-to-cloud.sh schema      # todas as migrations, sem seeds
infra/scripts/migrate-to-cloud.sh data        # dados do sistema + usuários do Auth (senhas incluídas); estoque e saldos vêm prontos
infra/scripts/migrate-to-cloud.sh vault       # chave dos CPFs + credenciais das integrações (arquivo temporário apagado no fim)
infra/scripts/migrate-to-cloud.sh verify      # contagens origem × destino, chave dos CPFs, funções sem login (0), rotinas agendadas
```

Com a loja fechada, sem vendas em andamento, repita as etapas `data`, `vault` e `verify` no projeto definitivo. A etapa `data` esvazia o destino antes de copiar, então pode ser repetida.

**Depois da cópia, no SQL Editor do Supabase:**
```sql
alter role agent_rpc password '<senha forte>';   -- a migration cria com a senha padrão; troque e use em CENTRALOPS_AGENT_DATABASE_URL
```

**Storage:** hoje os buckets `fin-docs` e `assistant-uploads` estão vazios. Se tiverem arquivos no dia da mudança, copie com `rclone` (S3 do Supabase) ou pelo painel.

**Edge Functions** (webhooks da Meta e do Telegram):
```bash
supabase functions deploy webhooks-meta --project-ref <ref> --no-verify-jwt
supabase functions deploy webhooks-telegram --project-ref <ref> --no-verify-jwt
supabase secrets set --project-ref <ref> META_VERIFY_TOKEN=… META_APP_SECRETS=… TELEGRAM_WEBHOOK_SECRET=…
```

## 4. Servidor online (web, worker, mcp)

Use o `docker-compose.yml` da raiz no Coolify do servidor novo. Variáveis, com os nomes **novos**, sem o prefixo `SIE_`:

| Variável | Serviço | Valor |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (**no build**) | `https://<ref>.supabase.co` e a chave anon. São gravadas na imagem: mudou, reconstrua |
| `CENTRALOPS_SUPABASE_URL` / `CENTRALOPS_SUPABASE_SERVICE_KEY` | web, worker | URL e `service_role` |
| `CENTRALOPS_DATABASE_URL` | worker, migrate | pooler em modo **sessão** (`…pooler.supabase.com:5432`), usuário `postgres.<ref>` |
| `CENTRALOPS_AGENT_DATABASE_URL` | worker, mcp | mesmo pooler, usuário `agent_rpc.<ref>` com a senha nova |
| `CENTRALOPS_OPENROUTER_KEY`, `CENTRALOPS_GROQ_KEY` | web, worker | IA |
| `CENTRALOPS_AGENT_CTX_SECRET`, `CENTRALOPS_MCP_KEY`, `CENTRALOPS_HERMES_KEY` | worker, mcp | os mesmos de hoje ou novos (`openssl rand -hex 32`) |

O provedor fiscal **não** precisa de variável de ambiente: a credencial fica em Configurações › Integrações (no Vault). Deixe configurado só o provedor escolhido. Os outros, sem credencial ou desativados, nunca são usados e não geram aviso. Se houver mais de um, marque o principal.

## 5. Virada e conferência

1. Aponte o domínio para o servidor novo.
2. Entre no sistema. As sessões antigas caem, porque a chave de login do Cloud é outra; as senhas continuam as mesmas.
3. Atualize os webhooks nos painéis:
   - Stone: `https://<domínio>/api/webhooks/stone`;
   - Notaas: `https://<domínio>/api/webhooks/notaas`;
   - Meta e Telegram: as Edge Functions do item 3.
4. Em **Marketing › Links**, preencha o endereço do sistema (o domínio novo). Os links curtos e QR passam a abrir para qualquer pessoa.
5. Configurações › Integrações: use **Testar** em cada integração.
6. Teste rápido:
   - abrir o caixa;
   - uma venda com NFC-e em homologação;
   - uma contagem;
   - uma malinha;
   - fechar o caixa;
   - a rotina de fechamento.
7. Rode `infra/scripts/restore-check.sh` com o primeiro backup tirado do Cloud.

**Voltar atrás:** até a primeira venda no Cloud, basta apontar o domínio de novo para o homelab. Depois disso, os dados novos estão só no Cloud.
