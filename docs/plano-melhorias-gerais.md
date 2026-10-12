# Plano de melhorias gerais: inaugurar, operar e crescer

> Versão 1.0 · 11/10/2026
>
> **Escopo:** o sistema inteiro, depois das correções de 11/10 (commit `f7fc7bf`, já implantado).
>
> **Base:** leitura do código e levantamento no servidor e no banco de produção, feitos em 11/10/2026.
>
> **Situação em 12/10/2026:** implementados
> - backup (0.1, parte local; falta a cópia externa);
> - contagem, ajuste, importação com estoque e custo, e etiquetas (0.5);
> - comprovante 80 mm e envio pelo WhatsApp (0.6);
> - rotina de abertura e fechamento (1.2);
> - avisos sem repetição (parte da 1.3);
> - malinhas e peças em campanha (2.4 ampliada);
> - adaptador da Brasil NFe pelo SDK oficial (parte da E7);
> - banco de testes isolado (E4);
> - trava de funções cobrindo `mkt` e `aff`;
> - roteiro de mudança para o Supabase Cloud ([infra/MIGRACAO-SUPABASE-CLOUD.md](../infra/MIGRACAO-SUPABASE-CLOUD.md)).
>
> O resto continua como plano.

**Conteúdo**
- Resumo
- Diagnóstico (partes A a D)
- Fase 0: blindar e inaugurar (tarefas 0.1 a 0.10)
- Fase 1: operação do dia a dia (1.1 a 1.9)
- Fase 2: vender mais (2.1 a 2.7)
- Fase 3: crescer com segurança (3.1 a 3.5)
- Trilha de engenharia (E1 a E15)
- Ordem, dependências e calendário
- Métricas
- Decisões dos sócios (numeradas de 1 a 12)

---

## Resumo

### O que encontrei

**1. O sistema está pronto no papel e vazio na prática.**
- Tem 123 telas, 84 itens de menu em 14 áreas, 107 migrations, 701 funções no banco e 30 rotinas agendadas.
- Em produção, porém, há zero produtos, vendas, conversas, notas emitidas e colaboradores.
- A conta `luisa@etteconceito.com` nunca foi acessada.
- O plano de negócios marca a abertura da loja na JOY para **outubro de 2026**, ou seja, agora.

**2. Quatro riscos precisam sair antes da primeira venda real:**
- **Backup:** o banco não tem nenhum. O agendamento aponta para um script que não existe, e a cópia mais recente na pasta de backups é de maio, e de outros serviços.
- **Acesso:** o sistema só abre pela Tailscale. Links curtos, QR codes e os avisos automáticos (webhooks) da Stone, da Notaas e da Meta não chegam de fora.
- **Fiscal:** o cadastro está incompleto (sem inscrição estadual, séries e certificado). Há dois provedores fiscais ativos e nenhum marcado como principal.
- **Servidor:** é um PC Windows. Depois de reiniciar, o sistema só volta quando alguém entra na máquina.

**3. Faltam telas para colocar a loja no sistema:**
- Não há tela de contagem nem de estoque inicial. A função existe no banco, mas nenhuma tela a chama.
- A importação de catálogo não traz quantidade nem custo.
- Não há etiqueta com código de barras.
- O comprovante não pode ser impresso nem enviado à cliente.

**4. Há ruído demais:**
- O menu tem 84 itens para uma loja de duas ou três pessoas.
- Um mesmo alerta chegou 38 vezes, e 25 continuam sem leitura.
- As rotinas agendadas falharam 184 vezes em 7 dias.
- O worker já fez cerca de 10 milhões de leituras em filas vazias.

**5. O processo de desenvolvimento deixa passar erro:**
- Integrações foram escritas sem validar no provedor: a busca de notas da Brasil NFe dá erro 404 a cada 2 horas.
- Não há na raiz do repositório um arquivo com as regras do projeto para os agentes de IA.
- O deploy é manual e não depende dos testes passarem.
- O banco de produção também guarda dados de outros projetos pessoais.

### O que proponho

Quatro fases e uma trilha de engenharia em paralelo:

| Fase | Quando | Objetivo |
|---|---|---|
| **0. Blindar e inaugurar** | próximas 2 semanas | backup, endereço público seguro, fiscal homologado, estoque e etiquetas, ensaio geral |
| **1. Operação do dia a dia** | semanas 3 a 6 | pendências num lugar só, rotinas de abertura e fechamento, alertas no celular, Stone conciliada sozinha, menu enxuto |
| **2. Vender mais** | meses 2 e 3, antes da Black Friday (27/11) e do Natal | link de pagamento e Pix, vitrine e catálogo na Meta, condicional, vale-presente, drops com plano de compra e giro, aluna JOY |
| **3. Crescer com segurança** | a partir do mês 3 | infraestrutura definitiva, várias lojas, consignação, portal do parceiro |
| **Engenharia** | contínua | regras para agentes, PR com CI, deploy automático, checagem de drift, contratos das integrações, observabilidade |

**Escala de esforço** (desenvolvimento com IA, sem contar a espera por terceiros):
- **P:** até 1 dia;
- **M:** 2 a 4 dias;
- **G:** 1 a 2 semanas.

---

## Diagnóstico

### A. Uso real em produção (11/10/2026)

| Área | No banco | O que significa |
|---|---|---|
| Produtos e estoque | 0 produtos, 0 variações, 0 saldos | catálogo e estoque inicial ainda não entraram |
| Vendas | 0 pedidos, 0 pagamentos, 0 sessões de caixa | o PDV nunca foi usado de verdade |
| Clientes | 599 cadastros (582 importados da base de outra loja); 0 consentimentos registrados | há base para relacionamento, mas nenhuma base legal registrada para marketing |
| Atendimento | 0 canais, 0 conversas | WhatsApp e Instagram não estão conectados |
| Fiscal | 0 notas; Brasil NFe e Notaas ativas, nenhuma principal; empresa sem IE, sem séries e sem validade do certificado | a NFC-e ainda não pode sair |
| Stone | integração `PENDING` | a maquininha integrada não está configurada |
| Equipe | 0 colaboradores | o módulo de RH não está em uso |
| Central (IA) | 0 conversas, 0 execuções | ainda não foi usada |
| Acesso e cadastro | 2 usuários, os dois administradores; empresa chamada "Minha empresa"; loja sem horário e sem data de abertura | a configuração inicial está incompleta |

### B. Infraestrutura e operação

**Backup**
- Situação:
  - o crontab chama `/home/paulojr/score-updater/backup.sh`, que não existe;
  - `~/backup.sh` inclui o banco, mas copia a pasta de dados com o Postgres ligado, o que gera cópia inconsistente; e não está agendado;
  - a cópia mais recente em `~/backups` é de 26/05, e de outros serviços.
- Risco: um defeito de disco apaga vendas, notas e financeiro sem volta.

**Acesso**
- Situação:
  - web e Supabase só respondem no IP da Tailscale (`nginx_secure`);
  - o Nginx Proxy Manager não tem nenhuma rota pública;
  - o endereço público usado nos links não foi configurado.
- Risco: não funcionam links curtos, QR, check-in, webhooks (Stone, Notaas, Meta, Telegram) nem celulares sem Tailscale.

**Servidor**
- Situação:
  - é um PC Windows com WSL2, sem tarefa que suba o WSL na inicialização;
  - a atualização automática do Windows está ligada;
  - tem 11 GB de RAM, com 4,9 GB de swap em uso;
  - além do Supabase, roda outros 18 contêineres (Coolify, Home Assistant, três Hermes, Evolution, Stirling, Vaultwarden etc.);
  - a mesma máquina serve para desenvolvimento, com builds e bancos de teste.
- Risco: o sistema cai em dia de loja aberta, ou fica lento.

**Rotinas agendadas**
- Situação:
  - são 30 jobs no pg_cron; 11 rodam a cada 1 a 15 minutos, e na virada da hora 12 começam juntos;
  - houve 184 falhas em 7 dias, todas `job startup timeout`, em blocos de até 14 na mesma hora;
  - o histórico (`cron.job_run_details`) nunca é limpo e já tem 30 mil linhas desde 02/10.
- Risco: rotinas de vencimento (reservas, pedidos, SLA) falham sem ninguém saber.

**Filas**
- Situação:
  - o worker lê 12 filas a cada 1 segundo, o que deu cerca de 9,7 milhões de leituras desde 02/09, quase todas vazias;
  - `fiscal_emission_dlq` guarda 10 mensagens do erro antigo da Notaas.
- Risco: CPU gasta sem motivo, e falhas sem tela para reprocessar.

**Alertas**
- Situação:
  - chegaram 38 notificações iguais "Busca de notas recebidas parou: Brasil NFe 404", 25 sem leitura;
  - os avisos só aparecem no sino.
- Risco: o alerta importante se perde no meio do repetido.

**Isolamento**
- Situação:
  - o mesmo Postgres guarda os bancos `evolution` e `paperclip`;
  - dentro do banco do sistema há tabelas de outros projetos (`public`, `drizzle`);
  - todos usam o mesmo superusuário e a mesma chave JWT.
- Risco: uma falha em outro app expõe os dados da loja, e o backup e a restauração ficam misturados.

**Segredos**
- Situação:
  - os três contêineres (web, worker, mcp) recebem as mesmas 13 variáveis `SIE_*`, inclusive a URL do banco como `postgres`;
  - o web usa só 4 delas.
- Risco: um vazamento num serviço expõe todos os segredos.

**Cadastro de contas no Supabase**
- Situação: `DISABLE_SIGNUP=false`, com cadastro por telefone ligado.
- Risco: qualquer pessoa que alcance a API cria uma conta. Ela não vê dados, mas a porta fica aberta sem necessidade.

**Documentação**
- Situação: `infra/README.md` e o workflow Release descrevem Supabase Cloud com VPS. A produção real é o homelab, com deploy manual no Coolify.
- Risco: quem seguir o README, pessoa ou agente, vai pelo caminho errado.

**Limite de linhas da API**
- Situação: o PostgREST daqui não tem limite de linhas, mas o Supabase Cloud corta em 1.000 por padrão. O PDV carrega todas as variações e preços de uma vez.
- Risco: numa mudança para a nuvem, o PDV perderia produtos sem dar erro.

### C. Lacunas de fluxo

**Funções que existem no banco e não são chamadas por nenhuma tela, worker ou agente:**

| Função | Para que serve | Onde faz falta |
|---|---|---|
| `inv.post_count` | lançar contagem de estoque | estoque inicial e inventário. A tela de Estoque diz que o saldo entra "pela contagem inicial", mas não há como fazer a contagem |
| `sales.set_payment_link` | gravar o link de pagamento no pedido | pedido remoto: hoje só aparece o aviso "Link de pagamento solicitado" |
| `mkt.set_campaign_costs` | custo da campanha | retorno de campanhas e eventos |
| `mkt.invite_vips` | convidar VIPs para evento | eventos e drops |
| `mkt.request_lookalike`, `mkt.delete_ad_audience` | público semelhante e exclusão de público na Meta | Anúncios |
| `sales.link_exchange` | ligar a troca à venda nova | Trocas |
| `fin.set_title_receiver`, `hr.set_roster_notes`, `hr.link_member` | ajustes pontuais | Financeiro e Escala |
| `sales.save_coupon`, `ai.eval_gate_check` | sem uso | decidir entre ganhar tela ou ser removidas |

**Outras lacunas:**
- **Estoque:**
  - existe a tabela `inv.transfers` e existem os tipos de movimento de consignação, mas sem nenhuma função nem tela;
  - não há venda condicional, vale-presente nem transferência entre lojas.
- **Stone:**
  - as filas `acquirer_sync` e `bank_sync` existem, mas o worker não as lê;
  - o extrato bancário entra por arquivo (OFX, ou CSV de Inter, BTG e Mercado Pago), mas a conta da empresa é na Stone;
  - os recebíveis da maquininha entram por uma planilha no layout do próprio sistema, montada à mão;
  - nada vem direto da Stone.
- **Importação de catálogo:**
  - traz só referência, nome, linha, categoria, NCM, cor, tamanho, EAN e preço;
  - o leitor de CSV não trata campos entre aspas.
- **Balcão:**
  - não há etiqueta nem impressão de comprovante;
  - a NFC-e não é enviada à cliente;
  - não há aplicativo instalável (PWA).
- **LGPD:** não há como exportar ou anonimizar os dados de alguém a pedido da própria pessoa. A coluna `anonymized_at` existe, mas nenhuma função a usa.

### D. Processo de desenvolvimento

- **Mudanças sem teste:** em 09 e 10/10 entraram 9 migrations e 3 integrações novas (Brasil NFe, Stone e Notaas) sem testes. A revisão de 11/10 achou falhas críticas de segurança e de dinheiro.
- **Adaptadores fiscais com nomes adivinhados:**
  - os campos foram adivinhados (`Versao` e `versao`, `Chave` e `ChaveAcesso`);
  - a busca de notas recebidas da Brasil NFe (`/ObterNotasFiscais`) responde 404 desde a instalação.
- **Migrations reexecutadas:** migrations antigas foram editadas e rodadas de novo à mão, o que desfez correções. Isso foi corrigido em `20261011000200`.
- **Sem regras para agentes:** a raiz não tem `AGENTS.md` nem `CLAUDE.md`. O único arquivo de instruções é o padrão do Next.js, em `apps/web`.
- **Testes na instância de produção:** os testes do banco rodaram em bancos temporários criados no mesmo Postgres de produção.
- **Tipos frágeis:** os tipos do banco são editados à mão, e o web tem 166 `as unknown as`.
- **Fluxos de dinheiro sem E2E:** nenhum dos 21 arquivos E2E percorre uma venda, troca, caixa ou nota. Só um deles abre a tela `/vender`, e apenas para conferir o layout no celular. Os demais cobrem cadastros, RH, marketing e a Central.
- **Arquivo grande demais:** `pos-terminal.tsx`, o arquivo mais alterado do PDV, tem 1.040 linhas.

---

## Fase 0: blindar e inaugurar (próximas 2 semanas)

A ordem foi pensada para a abertura da loja. Primeiro vem o que evita perda de dados e multa; depois, o que permite vender.

### 0.1 Backup do banco (M), antes de tudo

1. **Dump diário:**
   - dump lógico por schema, porque o `pg_dump` do banco inteiro dá segfault (por schema funciona; investigar a causa em paralelo);
   - incluir os schemas do sistema e mais `auth`, `vault`, `storage` e `supabase_migrations`.
2. **Chave do Vault:** guardar junto a chave raiz do Vault/pgsodium, que fica no volume `supabase_db-config`. Sem ela, os CPFs cifrados e as credenciais das integrações não voltam numa restauração.
3. **Cópia fora da máquina:**
   - cópia cifrada no Backblaze B2, no Cloudflare R2 ou no Google Drive, via rclone;
   - retenção de 7 cópias diárias, 4 semanais e 12 mensais;
   - os XMLs das notas precisam ser guardados por 5 anos.
4. **Agendamento:** corrigir o crontab que aponta para o script inexistente e tirar do `~/backup.sh` a cópia da pasta de dados com o banco ligado.
5. **Teste e alerta:** restaurar uma vez por mês num banco descartável e conferir as contagens. Se o backup falhar, avisar no celular.
6. **Depois (opcional):** WAL-G, que já vem na imagem `supabase/postgres`, enviando o WAL continuamente para o destino externo. Permite restaurar o banco em qualquer momento (PITR), e não só no ponto do último dump.

**Pronto quando:** o dump de ontem está no destino externo, uma restauração foi feita e registrada, e o alerta de falha foi testado.

### 0.2 Endereço público seguro com Cloudflare Tunnel (M)

1. **Domínio e túnel:** um domínio da loja e o `cloudflared` rodando no homelab. Não abre porta no roteador e esconde o IP de casa.
2. **Rotas públicas:**
   - `/r/*`: links curtos e QR;
   - `/api/webhooks/*`: Stone e Notaas;
   - as Edge Functions `webhooks-meta` e `webhooks-telegram`;
   - todas com limite de requisições.
3. **Acesso da equipe:**
   - o sistema e a API do Supabase ficam atrás do Cloudflare Access (código por e-mail) ou continuam só pela Tailscale (decisão 1);
   - Studio, Postgres (portas 5432 e 6543), Coolify e Portainer nunca ficam públicos;
   - o pooler e o Kong passam a escutar só em localhost ou na Tailscale.
4. **Endereço dos links:** preencher o "endereço completo do sistema" em Marketing › Links. É dele que `packages/domain/src/tracking.ts` monta cada link.

**Pronto quando:**
- um link curto abre no 4G de um celular sem Tailscale;
- um webhook de teste da Stone chega e é conferido na API;
- um `nmap` de fora não mostra Studio nem Postgres.

### 0.3 Servidor que volta sozinho (P)

1. **Volta automática:**
   - uma tarefa agendada do Windows, "ao iniciar", sobe o WSL (o Docker já sobe pelo systemd);
   - a BIOS religa o PC depois de falta de energia;
   - nobreak no PC, no modem e no roteador;
   - a janela de atualização do Windows fica fora do horário da loja.
2. **Monitor externo:** um serviço de fora (Better Stack ou UptimeRobot, ambos com plano gratuito) consulta o `/api/health` e avisa no celular.
3. **Memória:** tirar o banco do swap.
   - Limitar a memória ou mover os serviços que não são essenciais: as três instâncias do Hermes, Stirling e Home Assistant.
   - Desligar o Supabase Analytics (cerca de 320 MB) e o Studio quando não estiverem em uso.
   - Não rodar build nem banco de teste na mesma máquina em horário de loja (ver E4).
   - Os blocos de falha das rotinas indicam picos de carga na máquina.

**Pronto quando:** reiniciar o Windows de propósito traz o sistema de volta sem ninguém entrar, e uma queda gera aviso em até 5 minutos.

### 0.4 Fiscal pronto para a primeira NFC-e (M; depende do contador e da SEF/SC)

1. **Cadastro da empresa:**
   - inscrição estadual;
   - séries de NFC-e e NF-e;
   - CSC (identificador e código) da SEF/SC;
   - certificado A1, com a validade em `cert_expires_at` e aviso 30 dias antes de vencer;
   - matriz fiscal: NCM padrão, CFOP e CSOSN.
2. **Um provedor só.**
   - Homologar o escolhido, marcá-lo como principal e desativar os outros.
   - Hoje, sem principal, a emissão usa o provedor que a checagem de saúde atualizou por último, e isso alterna de fato: em 11/10, às 20h30 o escolhido era a Notaas, e às 21h00 a Brasil NFe.
   - Recomendação: ficar com o que passar no roteiro abaixo com menos ajustes. O Focus tem o adaptador mais testado (decisão 2).
3. **Roteiro de homologação:**
   - os casos:
     - venda simples;
     - venda com desconto;
     - item avulso;
     - vários pagamentos;
     - troca;
     - devolução;
     - cancelamento dentro do prazo;
     - rejeição provocada de propósito;
     - nota com CPF;
     - reenvio;
   - em cada caso, conferir o DANFE, o QR e se o XML foi guardado.
4. **Notas recebidas:**
   - confirmar na documentação da Brasil NFe qual é o endpoint certo, ou desligar a busca até validar;
   - depois, limpar a fila de falhas.

**Pronto quando:** o roteiro passa em homologação, e uma NFC-e real é emitida e cancelada em produção.

### 0.5 Catálogo, estoque inicial e etiquetas (G)

1. **Importação completa:**
   - traz quantidade por local, custo, fornecedor, coleção ou drop e marca;
   - aceita CSV (com aspas e vírgula decimal) e XLSX;
   - mostra uma prévia com o erro de cada linha;
   - importar de novo não duplica nada (a chave é referência + cor + tamanho).
2. **Código interno:** peças sem EAN ganham um código Code128 do SKU. O PDV já acha peça pelo SKU, tanto no leitor quanto na câmera.
3. **Tela de contagem** (usa `inv.post_count`):
   - bipar as peças por local: salão, estoque, armário VIP;
   - ver as divergências e ajustar com motivo;
   - o estoque inicial é a contagem do dia zero.
4. **Ajuste avulso de estoque** com motivo: avaria, brinde ou uso em marketing. Os tipos de movimento já existem.
5. **Etiquetas:**
   - PDF para impressora térmica de etiquetas (por exemplo, 40×25 mm), com nome, cor, tamanho, preço e código de barras;
   - geradas a partir da importação, do recebimento, da contagem ou de uma seleção;
   - reimpressão quando o preço muda.
6. **Preço sugerido por markup:** 2,40 no plano de negócios, configurável, com arredondamento (por exemplo, final ,90). Vale na importação e no recebimento.

**Pronto quando:** a coleção de abertura entra por planilha com estoque e custo, as etiquetas saem impressas e o PDV acha cada peça pelo bip.

### 0.6 PDV pronto para o balcão (M)

1. **Comprovante:**
   - impressão em impressora térmica de 80 mm, pelo próprio navegador;
   - envio do DANFE da NFC-e por WhatsApp (link `wa.me` com o texto pronto, sem depender da API) ou por e-mail.
2. **Stone:**
   - configurar as credenciais e homologar o Connect;
   - testar o plano B: maquininha avulsa, com o pagamento lançado no PDV junto do NSU.
3. **Contingência por escrito**, para quando a internet ou o servidor cair:
   - maquininha avulsa e formulário de papel;
   - o emissor web do provedor fiscal como plano C;
   - uma função nova para lançar a venda depois, com a data e a hora originais (só administrador, com motivo).

**Pronto quando:** um dia inteiro de ensaio acontece sem ajuda do desenvolvedor: abrir o caixa, fazer 10 vendas variadas, uma troca e uma sangria, fechar o caixa e conferir com a Stone.

### 0.7 Pessoas e configuração (P)

- Trocar o nome da empresa, que hoje é "Minha empresa".
- Preencher:
  - o horário da loja, que o SLA e o roteador de conversas usam;
  - a data de abertura;
  - a JOY como parceira anfitriã no cadastro da loja.
- Fazer o primeiro acesso da conta da Luisa.
- Criar a conta da vendedora com o perfil Vendedora e conferir o que cada perfil vê.

**Pronto quando:** cada pessoa entra com a própria conta e só vê o que precisa.

### 0.8 Ensaio geral e limpeza do treino (P)

1. Ensaiar agora, com o fiscal em homologação e antes de carregar o estoque real.
2. Em seguida:
   1. fazer um backup;
   2. rodar um script já testado que apaga os movimentos do treino (pedidos, pagamentos, caixa, movimentos de estoque e títulos);
   3. só então carregar os dados reais.
3. **Alternativa**, se a decisão de infraestrutura permitir: um ambiente de homologação separado no Coolify (E3), que também serve de treino para novas vendedoras.

### 0.9 Base de clientes e LGPD, antes de qualquer campanha (M)

1. **Base legal:**
   - os 582 cadastros vieram da base de outra empresa, e nenhum tem consentimento registrado;
   - a base legal precisa ser definida com o jurídico (decisão 4);
   - até lá, marcar esses cadastros como "sem base para marketing" e tirá-los de campanhas e de públicos da Meta;
   - o WhatsApp de marketing já exige aceite, mas o Instagram hoje só exclui quem recusou.
2. **Coleta de aceite com evidência:** no PDV (com texto versionado), no QR da loja e da academia, no check-in de eventos e no link da bio. Depende da 0.2.

**Pronto quando:** toda campanha mostra quantas pessoas ficaram de fora por falta de aceite, e cada aceite novo fica registrado com o texto e a origem.

### 0.10 A inauguração como primeira campanha real (P, se 0.2 e 0.9 estiverem prontas)

1. **O evento no sistema:** o "Mês 1: Inauguração Oficial", com orçamento de R$ 4.000, é montado no fluxo novo:
   - evento com convidadas e QR de check-in que já registra o aceite;
   - cupom de inauguração;
   - link na bio;
   - resultado com custo e vendas.
2. **WhatsApp:** pedir já a verificação da empresa na Meta e o número de WhatsApp Business, porque o processo leva dias. Usar a API oficial, para a qual o sistema foi feito. Não usar API não oficial no número da loja, por risco de bloqueio.

---

## Fase 1: operação do dia a dia (semanas 3 a 6)

### 1.1 "O que fazer agora": todas as pendências numa lista no Início (M)

- **Lista única:** junta as pendências de todas as áreas, conforme a pessoa e as permissões dela:
  - NFC-e rejeitada ou pendente;
  - venda paga sem nota;
  - conta a pagar hoje ou vencida;
  - reserva e armário vencendo;
  - conversa aguardando;
  - tarefa;
  - aniversariante do dia;
  - diferença de caixa;
  - conciliação pendente;
  - tamanho esgotado.
- **Funcionamento:** cada item abre a tela certa, já filtrada, e some quando é resolvido.
- **Reaproveita:** `resumo_do_dia` e `ai.suggestions`.

### 1.2 Rotinas de abertura e fechamento (M)

- **Checklist automático:** cada item se marca sozinho a partir dos dados do sistema.
  - Abertura: caixa aberto com troco, maquininha funcionando, lista do dia.
  - Fechamento: caixa fechado, nenhuma NFC-e pendente, conferência com a Stone, sangria ou depósito.
- **Resumo:** o fechamento chega aos sócios por mensagem.

### 1.3 Alertas que chegam e não se repetem (M)

- **Um alerta por problema:** fica aberto, com contador, e se resolve sozinho quando a situação volta ao normal. Hoje chegaram 38 iguais.
- **Gravidade e silêncio:** cada alerta tem gravidade, e há horário de silêncio.
- **Críticos no celular:** vão para o Telegram ou o WhatsApp dos sócios. O adaptador do Telegram já existe. São críticos:
  - nota rejeitada;
  - fila de falhas;
  - backup;
  - servidor fora do ar;
  - certificado vencendo;
  - integração fora do ar.
- **Briefing da manhã:** passa a chegar também por mensagem. Hoje só aparece no sino, e 5 de 9 estão sem leitura.

### 1.4 Tela "Saúde do sistema" em Configurações (M)

- **Filas e falhas:** com botão para reprocessar ou descartar.
- **Rotinas agendadas:** com a última falha de cada uma.
- **Também mostra:**
  - integrações;
  - último backup;
  - versão implantada;
  - migrations aplicadas.

### 1.5 Stone de ponta a ponta (G)

- **Entrada automática:** os recebíveis da maquininha e o extrato da conta Stone entram sozinhos e são conciliados automaticamente com vendas e títulos. Para isso, o worker passa a ler as filas `acquirer_sync` e `bank_sync`, que já existem.
- **Se a Stone não liberar as APIs** para essa conta: importar o arquivo de conciliação e o extrato da Stone, com layout próprio, nas telas que já existem.

**Pronto quando:** a venda de ontem aparece conciliada hoje, sem upload de arquivo.

### 1.6 Menu com só os módulos em uso (M)

- **Chave por módulo:** cada módulo tem uma chave liga/desliga na empresa (Atendimento, Equipe/Folha, eSocial, Inteligência, Compras, Eventos etc.). O menu mostra só o que está ligado, e há "mostrar tudo" para administradores.
- **Na abertura:** ficam ligados Vender, Produtos & Estoque, Clientes, Marketing, Financeiro, Fiscal (notas) e Configurações. O resto entra quando começar a ser usado; por exemplo, Atendimento quando o WhatsApp for conectado.
- **Rotinas agendadas:** as dos módulos desligados deixam de rodar.

### 1.7 Folha e eSocial com o contador (P)

- **Recomendação:** com uma vendedora CLT, o contador faz a folha e o eSocial.
- **O que fica no sistema:**
  - escala;
  - ponto;
  - comissão de 3% pela regra 60/40;
  - importação do resumo da folha como contas a pagar.
- **Telas desligadas:** folha, rescisão e eSocial, até serem conferidas lado a lado com o contador por 2 meses (decisão 5).

### 1.8 Pacote mensal para o contador (M)

- **Envio automático:** no fechamento do mês, o sistema gera o pacote e o envia por e-mail ou para uma pasta compartilhada:
  - XMLs das notas emitidas e recebidas;
  - vendas por forma de pagamento;
  - extratos conciliados;
  - DAS calculado;
  - comissões.
- **Hoje:** a exportação existe, mas é feita à mão, tela por tela.

### 1.9 A Central (IA) no balcão (P)

- **Três usos para começar:** a vendedora usa a Central para:
  - ver estoque por tamanho ("tem a legging preta no M?");
  - cadastrar cliente pela foto do documento;
  - fazer venda falada.
- **Medição:** pelas métricas da seção 11 do [plano da IA](plano-ia-integrada.md), com ajustes conforme o uso. Não precisa de código novo.

---

## Fase 2: vender mais (meses 2 e 3)

A ordem prioriza o que gera receita antes da Black Friday (27/11) e do Natal.

### 2.1 Link de pagamento e Pix automáticos pela Pagar.me, com a mesma chave da Stone (M)

- **Geração:** a partir do pedido remoto ou da conversa, gera um link de cartão (com parcelas) ou um Pix com validade.
- **Baixa automática:** o webhook avisa, o servidor confere na API e marca o pedido como pago.
- **Lembrete:** sai antes do link vencer; o aviso automático `PAYMENT_LINK_REMINDER` já existe.
- **Reaproveita:** `sales.set_payment_link`, que já está no banco, e o cliente da Stone para `/core/v5/orders`.

**Pronto quando:** uma venda pelo WhatsApp é paga e baixada sem a vendedora conferir o extrato.

### 2.2 Vitrine compartilhável (G)

- **Página pública** por coleção ou drop e por produto, com fotos, tamanhos disponíveis (estoque ao vivo) e preço.
- **Dois botões:**
  - "Quero reservar" cria uma reserva pendente e uma conversa ou tarefa;
  - "Comprar pelo WhatsApp" abre a conversa com o texto da peça pronto.
- **Links rastreados:** entram na atribuição de campanha que já existe.
- **Sem checkout no começo,** o que combina com a loja dentro da academia.
- **Dependências:** a 0.2 e as fotos dos produtos (a tabela `catalog.product_media` já existe).

### 2.3 Catálogo na Meta (M)

- **Feed de produtos** com estoque, numa URL pública. Serve:
  - ao catálogo do Instagram;
  - ao catálogo do WhatsApp;
  - aos anúncios de catálogo.
- **Eventos de conversão (CAPI):** já existem.

### 2.4 Venda condicional, a "malinha" (G)

- **Separar as peças:** no nome da cliente, com prazo de devolução.
- **Termo em PDF:** com os valores das peças.
- **Estoque:** as peças aparecem como "em condicional".
- **Lembrete:** sai antes do prazo vencer.
- **No retorno:** cada peça é devolvida ou vira venda no PDV.
- **Por quê:** é prática comum em loja de moda. O Armário VIP só resolve dentro da academia.

### 2.5 Vale-presente (M)

- **Venda:** é vendido no PDV, com código e cartão com QR.
- **Saldo:** fica no livro de créditos que já existe, `sales.store_credit_ledger`.
- **Uso:** vale como forma de pagamento. Até ser usado, é contabilizado como obrigação.
- **Datas fortes:** Dia das Mães, Natal e aniversários.

### 2.6 Drops com plano de compra e giro (G)

- **Plano de compra:**
  - parte do orçamento e chega às quantidades por categoria (60/30/10) e por tamanho (P/M/G em 40/45/15), tudo configurável;
  - o resultado vira um rascunho de pedido de compra.
- **Giro por drop:**
  - mostra o vendido sobre o recebido em 7, 14, 30 e 60 dias, e a cobertura em semanas por tamanho e cor;
  - sugere remarcação para o que parou e reposição para o que esgota, alimentando a tela de Reposição.
- **Resultado do evento:**
  - custo, com R$ 4.000 por evento no plano, lançado por `mkt.set_campaign_costs`;
  - convidadas, por `mkt.invite_vips`;
  - check-ins;
  - vendas atribuídas;
  - retorno.

### 2.7 Aluna JOY (M)

- **Marcação:** "aluna JOY", vinda do QR ou do check-in. Os dados nunca são importados da academia.
- **Benefício:** configurável.
- **Relatório da parceria:** vendas para alunas e eventos.
- **Base para o portal do parceiro** (3.4).

---

## Fase 3: crescer com segurança (a partir do mês 3)

### 3.1 Infraestrutura definitiva (decisão 3)

**Opção A: homelab endurecido.**
- Como fica: Supabase só do sistema, separado dos outros projetos, com nobreak, backup externo testado, Cloudflare Tunnel e monitor externo.
- Custo baixo, mas depende da energia e da internet de casa.

**Opção B: VPS com Supabase Cloud,** como desenhado em `infra/README.md` e no workflow Release.
- Traz restauração a qualquer momento (PITR, um adicional do plano Pro), TLS e operação fora de casa.
- Tem custo mensal e menos risco.
- Antes da mudança, paginar ou buscar no servidor as telas que carregam listas inteiras, a começar pelo PDV. Por padrão, o Supabase Cloud devolve no máximo 1.000 linhas por consulta.

**Recomendação:**
- ficar com a A agora e passar para a B antes da segunda loja;
- em qualquer caso, separar já o banco do sistema dos outros projetos, que hoje dividem o superusuário e a chave JWT.

### 3.2 Várias lojas (G)

- **Transferência entre lojas:** a tabela `inv.transfers` já existe, mas sem funções.
- **Relatórios:** por loja e consolidados.
- **Fiscal:** séries por loja.
- **Acesso por loja:** `member_store_access` já existe.

### 3.3 Consignação com parceiros (G)

- **Fluxo:**
  - remessa para o parceiro;
  - acerto periódico do que foi vendido, que vira conta a receber e nota;
  - retorno do que não vendeu.
- **Já existem:** os tipos de movimento `CONSIGNMENT_OUT/RETURN` e o contrato `CONSIGNMENT_PARTNER`.
- **Serve de base:** para o modelo de consignação do plano de expansão.

### 3.4 Portal do parceiro: academia e trainers (G)

Está adiado no plano de marketing até o contrato ser fechado. Reaproveita a 2.7 e as afiliadas.

### 3.5 Aplicativo instalável (PWA) para o balcão (M)

- **Uso:** ícone na tela do celular, que abre direto no PDV.
- **Sem internet:** consulta de preço e estoque pelo último catálogo guardado no aparelho.
- **Venda sem internet:** só se as quedas continuarem frequentes depois da 0.3. É complexo por causa do estoque e da nota.

### Ideias para avaliar depois (sem prioridade)

- Cotação e etiqueta de frete (Melhor Envio), se houver venda para fora.
- Agenda de provador ou de personal styling para VIPs.
- Cashback, que o plano de marketing manda decidir só depois de analisar a margem.
- Assistente pelo WhatsApp da equipe, que é a etapa 4 do plano da IA.

---

## Trilha de engenharia (contínua, em paralelo)

### E1. Regras do projeto para agentes de IA (P)

- **O quê:** criar `AGENTS.md` na raiz, com um `CLAUDE.md` que aponta para ele. As regras:
  - migration já aplicada não se edita;
  - toda RPC é `SECURITY DEFINER`, chama `require_perm` e a migration termina com `lock_functions`;
  - cada regra de negócio tem teste pgTAP;
  - adaptador só entra com contrato validado no provedor;
  - segredo nunca vai ao navegador;
  - webhook só avisa, e o servidor confere na API do provedor;
  - testar sem tocar a produção.
- **Por quê:** quase todos os problemas da revisão de 11/10 foram convenções do projeto quebradas por agente.

### E2. Branch e PR com CI obrigatório (P)

- **O quê:** agentes trabalham em branch e abrem PR; a `main` fica protegida e só aceita merge com o CI verde.
- **Por quê:** hoje tudo vai direto para a `main`.

### E3. Deploy automático e ambiente de homologação (M)

- **O quê:**
  - deploy automático depois do CI verde, por uma Action com Tailscale chamando a API do Coolify, ou por um runner no próprio homelab;
  - ambiente de homologação com banco próprio.
- **Por quê:** o deploy é manual e não depende dos testes.

### E4. Banco de testes fora da produção (P)

- **O quê:** um script `scripts/test-db.sh` que sobe um contêiner próprio, com os stubs, e é descartado depois.
- **Por quê:** hoje os bancos `fresh` e `scratch` são criados na instância de produção.

### E5. Checagem noturna de drift (M)

- **O quê:** comparar funções e tabelas da produção com um banco montado do zero, e alertar quando divergirem.
- **Por quê:** o drift de 4 funções passou despercebido.

### E6. Tipos gerados e RPC tipada (M)

- **O quê:**
  - tipos do banco gerados por script e conferidos no CI;
  - helpers de RPC tipados, com validação zod na entrada e na saída, para acabar com os 166 `as unknown as`.
- **Por quê:** hoje os tipos são editados à mão e as conversões não são checadas.

### E7. Contratos das integrações (M por provedor)

- **O quê:**
  - respostas gravadas do sandbox de cada provedor (Stone, Brasil NFe, Notaas, Focus, Meta), usadas nos testes;
  - um checklist de homologação por provedor;
  - marca "experimental" até a validação.
- **Por quê:** os adaptadores usam campos adivinhados.

### E8. Observabilidade (M)

- **O quê:**
  - Sentry (ou GlitchTip local) no web, no worker e no mcp;
  - métricas de fila, rotina e emissão na tela Saúde (1.4);
  - `log_min_duration_statement` e `track_io_timing` ligados.
- **Por quê:** hoje um erro só aparece se alguém abrir o log.

### E9. Banco e worker mais leves (M)

- **O quê:**
  - um despachante único, ou horários escalonados, para as 11 rotinas frequentes;
  - limpeza periódica de `cron.job_run_details`;
  - worker com `pgmq.read_with_poll`, ou com espera crescente quando a fila está vazia;
  - ajustar `shared_buffers` quando houver dados.
- **Por quê:** foram 184 falhas de início de rotina e cerca de 10 milhões de leituras vazias.

### E10. Variáveis de ambiente (P)

- **O quê:**
  - cada serviço recebe só as variáveis de que precisa;
  - os nomes passam a ser `CENTRALOPS_*`;
  - depois, apagar `legacy_env.py`.
- **Por quê:** os três contêineres recebem todos os segredos, com os nomes antigos.

### E11. Segurança de acesso (M)

- **O quê:**
  - conferir se a senha do papel `agent_rpc` foi trocada (a migration `foundation` cria o papel com a senha padrão de desenvolvimento);
  - desligar o cadastro público no Auth, se a instância for só do sistema;
  - MFA para administradores;
  - pooler e Kong escutando só em localhost ou na Tailscale;
  - regras de limite de requisições no Cloudflare;
  - um roteiro de troca de chaves.
- **Por quê:** ver o diagnóstico, parte B.

### E12. E2E dos fluxos de dinheiro (M)

- **O quê:** cobrir:
  - o PDV, com vários pagamentos, desconto, item avulso e cupom;
  - troca e devolução;
  - cancelamento com NFC-e;
  - caixa;
  - pedido remoto;
  - a Stone simulada.
- **Por quê:** nenhum dos 21 E2E percorre uma venda.

### E13. Dividir `pos-terminal.tsx` (M)

- **O quê:** separar as 1.040 linhas em carrinho, pagamentos, cliente e rascunho, com testes de unidade.
- **Por quê:** é o arquivo mais alterado e mais frágil do PDV.

### E14. Documentação fiel à realidade (P)

- **O quê:**
  - README com a coluna "em produção desde";
  - `infra/README.md` e o ADR-0007 descrevendo o homelab real;
  - workflow Release ajustado ou removido.
- **Por quê:** a documentação descreve outra infraestrutura.

### E15. Limpar o que não tem uso (P)

- **O quê:**
  - dar tela ou remover cada função da lista do diagnóstico, parte C;
  - desligar provedores e rotinas sem uso.
- **Por quê:** menos superfície para errar.

---

## Ordem, dependências e calendário

| Período | Entregas | Observação |
|---|---|---|
| **Semana 1 (12 a 18/10)** | 0.1, 0.3, 0.7, E1, E10; começar 0.2, o pedido de IE, séries e CSC ao contador, e a verificação da Meta | o backup vem antes de tudo; os pedidos a terceiros saem logo, porque demoram |
| **Semana 2 (19 a 25/10)** | 0.4 (homologação), 0.5, 0.6, 0.8, 0.9; 0.10 se der | inauguração ao fim da semana 2, ou quando 0.4 a 0.6 passarem |
| **Semanas 3 a 6** | 1.3 e 1.4 primeiro (baratos e protegem); depois 1.1, 1.2, 1.6, 1.5, 1.8; E2 a E5, E12 | os alertas e a tela Saúde antes das telas novas |
| **Até a Black Friday (27/11)** | 2.1, 2.5 e 2.2 | as três geram receita no fim do ano |
| **Dezembro e janeiro** | 2.3, 2.4, 2.6, 2.7; E6 a E9, E11, E13 | 2.6 antes do próximo drop do calendário |
| **A partir do mês 3** | Fase 3, conforme a decisão 3 | 3.1 antes de 3.2 |

**Dependências principais:**
- **0.2** é pré-requisito de:
  - 0.9 (QR de aceite);
  - 0.10;
  - 2.1 (webhooks);
  - 2.2 e 2.3 (páginas públicas);
  - conectar o WhatsApp.
- **0.1** vem antes de 0.8 (a limpeza do treino precisa de backup).
- **0.4** vem antes da primeira venda com nota.
- **E1** vem antes da próxima rodada de trabalho de agentes.
- **1.4** fica completa com E8 e E9.

---

## Métricas

**Inauguração**
- 100% das vendas com NFC-e autorizada em até 5 minutos.
- Nenhuma venda fora do sistema depois da primeira semana.
- Backup externo verificado em 30 de 30 dias.

**Operação**
- Fechamento de caixa em menos de 10 minutos, com diferença registrada.
- Pelo menos 95% das vendas Stone conciliadas sem intervenção.
- Alertas críticos lidos em menos de 1 hora.
- Nenhuma rotina falhando sem aviso.

**Vendas**
- Vendas remotas pagas por link.
- Conversão de reservas e condicionais.
- Giro do drop em 30 dias.
- Recompra em 90 dias.
- Porcentagem da base com aceite de marketing.

**Engenharia**
- 100% dos merges por PR com CI verde.
- Drift zero.
- Tempo do push ao deploy.
- Erros por dia (Sentry).

---

## Decisões dos sócios

1. **Acesso da equipe:** Cloudflare Access (código por e-mail; recomendado para o celular da vendedora) ou Tailscale instalada em cada aparelho?
2. **Provedor fiscal único:** Focus, Brasil NFe ou Notaas? Escolher pelo preço, pelo suporte e pelo resultado do roteiro de homologação.
3. **Infraestrutura:** homelab endurecido agora e nuvem antes da segunda loja (recomendado), ou nuvem já?
4. **Base importada:** qual a base legal, decidida com o jurídico? Até lá, ela fica fora de campanhas e de públicos.
5. **Folha e eSocial:** com o contador (recomendado) ou pelo sistema?
6. **Domínio público:** qual será o domínio da loja e o endereço curto dos links?
7. **Impressoras:** quais modelos de térmica de 80 mm para o comprovante e de impressora de etiquetas? A escolha define o layout.
8. **Preço:** qual markup padrão e qual regra de arredondamento?
9. **Condicional:** qual o prazo, o limite de peças ou de valor, e quem pode liberar?
10. **Vale-presente:** qual a validade e quais as regras de uso?
11. **Aluna JOY:** qual benefício, e o que entra no relatório para a academia?
12. **WhatsApp:** número dedicado da loja pela API oficial (recomendado)?
