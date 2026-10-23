# App do PDV na maquininha Stone (Smart POS)

App Android nativo (`apps/pos-android`) que roda **dentro** do terminal Smart POS da Stone (Positivo L300/L400, Gertec GPOS700X, Sunmi P2):
lê o código de barras pela câmera, monta a venda, cobra no app de pagamento da Stone, fecha a venda no CetraOps (estoque, financeiro,
contabilidade e NFC-e, como o PDV web) e imprime o DANFE NFC-e na bobina.

## Como funciona

```
 Terminal Stone                                        CetraOps (servidor)
 ┌──────────────────────────────┐                      ┌───────────────────────────────────────────┐
 │ App PDV (Kotlin/Compose)     │  HTTPS /api/pos/*    │ Next.js  lib/pos-api.ts                   │
 │  câmera + ML Kit (EAN/Code128)│ ───────────────────▶ │  X-Device-Token (maquininha pareada)      │
 │  catálogo guardado no aparelho│                      │  Bearer JWT do operador (RLS e permissões)│
 │  venda gravada a cada passo   │                      │        │                                  │
 │        │ Deeplink             │                      │        ▼                                  │
 │        ▼                      │                      │ Postgres: sales.open/confirm_stone_       │
 │ App de pagamento da Stone     │                      │  deeplink_charge → sales.create_pos_order │
 │ (cartão, senha, Pix, via do   │                      │  → NFC-e na fila do worker (SEFAZ direta) │
 │  cliente) · app de impressão  │                      └───────────────────────────────────────────┘
 └──────────────────────────────┘
```

**Integração com a Stone: Deeplink** (o modelo que a própria Stone recomenda no SDK Android: “use o Deeplink como base;
Provider só como exceção”). O app de pagamento da Stone cuida de cartão, senha, Pix e da via do cliente; o resultado volta para o nosso
app em `cetraopspdv://pay-response`. Estorno (`cancel-app://cancel`) e impressão (`printer-app://print`) também. Não precisa do token
privado do PackageCloud nem de `StoneStart.init`/ativação do Stone Code (o terminal já vem ativado com a conta da loja).

### Venda, passo a passo
1. **Pareamento (uma vez por terminal)** — o sócio abre *Configurações › Integrações › Stone › App do PDV na maquininha*, escolhe a loja e
   gera um código de 8 caracteres (vale 15 min, uma vez). No app: endereço do sistema + código. O servidor devolve um token que só existe
   no terminal (criptografado com o Keystore do Android); o banco guarda apenas o hash.
2. **Login** — cada vendedora entra com o próprio usuário do sistema; a venda fica no nome dela e valem as permissões dela
   (`sales.write`; desconto só com `sales.discount`).
3. **Itens** — câmera (EAN-13/8, UPC, Code 128/39, QR) ou busca por nome/referência/SKU; leitor USB/teclado também funciona (Enter).
   Código da referência abre a escolha de cor/tamanho. Não deixa vender acima do estoque vendável da loja.
4. **Pagamento** — cliente pelo telefone (cupom pessoal entra sozinho), CPF na nota, cupom, desconto, e as formas:
   crédito (até 12x sem juros, `MERCHANT`), débito, Pix (pela Stone) e dinheiro com troco (precisa do caixa aberto na tela web).
   Pagamento dividido em várias formas é aceito. Com pagamento feito, os itens travam (o valor cobrado precisa bater com a venda);
   para mexer, estorne o pagamento (botão *Estornar* chama o app de cancelamento da Stone com o ATK).
5. **Fechamento** — `sales.create_pos_order` com a mesma regra do PDV web; a NFC-e entra na fila do worker. O app acompanha a emissão
   e imprime o DANFE NFC-e (QR Code como imagem) quando a SEFAZ autoriza; sem autorização ainda, imprime o comprovante não fiscal.
   *Vendas de hoje* reimprime.

### Segurança da cobrança
Na integração Connect/POI (PDV web) o servidor confere o pagamento na API do Pagar.me. No Deeplink a transação acontece no terminal e não
existe ordem no Pagar.me, então:
- a cobrança é **aberta no servidor antes** (`sales.open_stone_deeplink_charge`: valor, forma e parcelas gravados);
- o retorno só é aceito **de uma maquininha pareada** e de operador com `sales.write` (`sales.confirm_stone_deeplink_charge`);
- o valor aprovado tem de ser o valor aberto; o **ATK** (chave da transação na Stone) é único por empresa — a mesma transação não paga
  duas cobranças; a venda só usa cobrança `PAID` e uma única vez (regra já existente do `create_pos_order`);
- a conferência final com a Stone é a **conciliação do adquirente** (ATK/autorização ficam no pagamento).
- O app mascara o PAN (só os 4 últimos) antes de mandar ao servidor.

Se o Android fechar o app no meio do pagamento, a venda volta igual (gravada a cada passo). Se o retorno da Stone se perdeu, o app pergunta:
“foi aprovada?” → abre o estorno da Stone para escolher a transação, ou fecha a cobrança como não aprovada.

## Arquivos

| Onde | O quê |
|---|---|
| `supabase/migrations/20261018000100_pos_app_deeplink.sql` | `sales.pos_devices`, colunas `source/device_id/atk/itk` em `sales.stone_pos_orders`, RPCs de pareamento e cobrança |
| `supabase/tests/073_pos_app_deeplink_test.sql` | pgTAP: pareamento, permissões, valor divergente, ATK repetido, venda, desativação |
| `apps/web/lib/pos-api.ts` | autenticação do app (token da maquininha + JWT), limite de tentativas, erros |
| `apps/web/app/api/pos/**` | `pair`, `auth/login`, `auth/refresh`, `bootstrap`, `catalog` (ETag), `customers`, `coupons/[code]`, `charges`, `charges/[id]/confirm|close`, `sales`, `sales/[id]` |
| `apps/web/lib/pos-catalog.ts`, `pos-sale.ts`, `pos-types.ts` | catálogo e venda compartilhados entre PDV web e app |
| `apps/web/app/(app)/configuracoes/integracoes/pos-devices-*` | tela do sócio: gerar código, ver, desativar maquininhas |
| `apps/pos-android/` | o app (Kotlin 2.0, Compose, CameraX + ML Kit embutido, OkHttp, ZXing para o QR) |

## Compilar

Sem Android Studio, num contêiner (JDK 17 + Android SDK):

```bash
apps/pos-android/scripts/build.sh
```

- `assembleDebug` (padrão): pacote `br.com.cetraops.pdv.loja.dev`. Em celular comum (sem os apps da Stone) e com a integração Stone em
  **sandbox**, o pagamento abre um simulador (aprovar/recusar). Em produção o simulador não aparece.
- `assembleRelease`: R8 ligado; assina se existir `apps/pos-android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
- `test`: testes de unidade (centavos, cupom, rateio de desconto, CPF).
- Endereço padrão do servidor no APK: `-PpdvServerUrl=https://…` (senão, digitado no pareamento).

## Antes de usar na loja (pendências fora do código)

1. **HTTPS público — pelo relay da Vercel** (ver *Caminho da rede* abaixo): ativar o Funnel da Tailscale, publicar o relay com
   `POS_UPSTREAM`/`POS_RELAY_SECRET` e pedir à Stone a liberação do domínio `stone-relay-seven.vercel.app` (a conectividade do chip
   Stone passa por proxy com lista de URLs).
2. **Aplicar a migration** `20261018000100_pos_app_deeplink.sql` e fazer o deploy do web.
3. **Programa de parceiros Stone** (souparceiro@stone.com.br / Partner Hub): pedir os apps da Stone no terminal de desenvolvimento,
   o roteiro de homologação e as **chaves de assinatura por fabricante** (Positivo, Gertec, Tectoy exigem flavors assinados com a
   keystore deles). Depois da homologação, a Stone distribui o app aos terminais da loja.
4. **Ajustes do app que a Stone confere**: contatos reais no “Fale conosco” (`res/values/strings.xml`, `support_text`), ícone e nome sem
   marca da Stone/fabricante (já está assim), `versionName` só com números e pontos, APK < 70 MB, sem WebView/WebSocket (não usamos).
5. No terminal: em *Ajustes* do app, imprimir o teste e escolher as colunas da bobina (32/40/42/48) que preenchem a linha.
6. Dinheiro no app depende de caixa aberto (abrir/fechar caixa continua na tela web).

## Caminho da rede

O CetraOps mora no homelab, que só responde pela Tailscale, e o terminal não instala VPN. O app fala só com o relay da Vercel, que já
recebe o webhook da Stone:

```
terminal ──HTTPS──▶ stone-relay-seven.vercel.app/api/pos/*   (Vercel, região gru1; infra/stone-relay/api/pos-proxy.js)
                         │ + X-Relay-Secret
                         ▼
          https://mpbflndsk201-wsl.tabby-broadnose.ts.net:10000   (Tailscale Funnel → 127.0.0.1:8090)
                         ▼
          nginx (~/nginx_secure/nginx.conf, bloco “app do PDV”): só /api/pos/* e só com o segredo; o resto é 404/403
                         ▼
          CetraOps web 127.0.0.1:3050
```

- Webhook continua por fila (não precisa de resposta na hora); o app precisa, por isso o repasse é direto.
- Nada fica guardado na Vercel; a autenticação continua no CetraOps (token da maquininha + JWT). O IP do terminal segue em `X-Real-IP`
  para o limite de tentativas de pareamento/login.
- Segredo: `POS_RELAY_SECRET` em `~/.stone-relay-secrets` (homelab), no nginx e nas variáveis do projeto `stone-relay` na Vercel.

Ligar (uma vez):

```bash
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:8090
cd infra/stone-relay && npx vercel login
npx vercel env add POS_UPSTREAM production        # https://mpbflndsk201-wsl.tabby-broadnose.ts.net:10000
npx vercel env add POS_RELAY_SECRET production    # o de ~/.stone-relay-secrets
npx vercel deploy --prod
curl -s https://stone-relay-seven.vercel.app/api/pos/bootstrap   # {"error":"Maquininha não pareada"} = caminho completo funcionando
```

Desligar o acesso público: `sudo tailscale funnel --https=10000 off`.

Quando o sistema for para um servidor online, basta apontar `POS_UPSTREAM` para ele (o app não muda).

## Fora do escopo desta versão
- Encomenda (peça sem estoque) e item avulso: continuam no PDV web.
- Cancelar/devolver venda já fechada: pela venda na tela web (trocas e devoluções).
- Provider do SDK (`stone-sdk-posandroid`): não é necessário para pagar/estornar/imprimir; precisaria do token do PackageCloud.
