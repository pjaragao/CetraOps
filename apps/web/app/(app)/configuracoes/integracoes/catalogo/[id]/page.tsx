import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { str, type SP } from "@/lib/context";
import { Badge, Button, Card, inputClass, Narrow, PageHeader } from "@/components/ui";
import { Flash } from "@/components/form";
import { saveProductSettingsAction, syncMetaCatalogAction } from "../actions";

export const metadata = { title: "Produtos no WhatsApp" };

interface SyncInfo {
  at?: string; ok?: boolean; error?: string | null; catalog_name?: string; product_count?: number;
  items?: number; sent?: number; deleted?: number; errors?: number;
}

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

export default async function CatalogoPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  await requirePerm("core.admin");
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: ch } = await supabase.schema("omni").from("channel_accounts")
    .select("id, channel, display_name, provider_account_id, product_send_mode, meta_catalog_id, meta_catalog_sync").eq("id", id).maybeSingle();
  if (!ch || ch.channel !== "WHATSAPP") notFound();
  const native = ch.product_send_mode !== "DIRECT";
  const sync = (ch.meta_catalog_sync ?? {}) as SyncInfo;

  return (
    <Narrow>
      <PageHeader title={`Produtos no WhatsApp: ${ch.display_name}`}
        description="Como a IA e a equipe mandam produtos quando a cliente pede fotos. O padrão é o catálogo nativo do WhatsApp: a cliente recebe cartões com foto, nome e preço e pode montar um carrinho. Se algo falhar, a resposta sai pelo envio direto (fotos + texto), sem deixar a cliente esperando."
        actions={<Link href="/configuracoes/integracoes" className="rounded-lg px-3 py-1.5 text-sm hover:bg-surface-2">← Integrações</Link>} />
      <Flash ok={str(sp.ok)} erro={str(sp.erro)} />
      <form action={saveProductSettingsAction} className="space-y-4">
        <input type="hidden" name="id" value={ch.id} />
        <Card title="Modo de envio de produtos">
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2"><input type="radio" name="product_send_mode" value="NATIVE_CATALOG" defaultChecked={native} className="mt-1" />
              <span><b>Catálogo nativo do WhatsApp</b> <Badge tone="success">padrão</Badge>
                <span className="block text-xs text-muted">As fotos de peças do catálogo viram cartões (uma peça) ou uma lista de produtos (várias). Peça que ainda não está no catálogo da Meta, catálogo não configurado ou recusa da Meta: sai pelo envio direto.</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" name="product_send_mode" value="DIRECT" defaultChecked={!native} className="mt-1" />
              <span><b>Envio direto pelo sistema</b>
                <span className="block text-xs text-muted">Como antes: cada foto sai como imagem com a legenda, e o texto em seguida.</span></span></label>
          </div>
        </Card>
        <Card title="Catálogo da Meta (da franquia)">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">ID do catálogo</span>
            <input name="meta_catalog_id" defaultValue={ch.meta_catalog_id ?? ""} inputMode="numeric" pattern="[0-9]{5,25}" placeholder="ex.: 1234567890123456"
              className={`${inputClass} max-w-xs`} aria-describedby="catalog-help" />
          </label>
          <p id="catalog-help" className="mt-1 text-xs text-muted">Sem ID, o modo nativo funciona como o envio direto. O CetraOps alimenta este catálogo com o catálogo interno (um item por modelo e cor, com preço, foto, estoque e link): não depende do site da marca nem do app da Shopify.</p>
        </Card>
        <Button>Salvar</Button>
      </form>

      {ch.meta_catalog_id && (
        <Card title="Sincronização com a Meta" className="mt-4"
          action={<form action={syncMetaCatalogAction}><input type="hidden" name="id" value={ch.id} /><Button variant="secondary" className="px-2 py-1 text-xs">Sincronizar agora</Button></form>}>
          {!sync.at ? <p className="text-sm text-muted">Ainda não sincronizado. A primeira rodada começa ao salvar e depois roda a cada 2 horas (só o que mudou).</p> : (
            <div className="space-y-1 text-sm">
              <p className="flex items-center gap-2">
                <Badge tone={sync.ok && !sync.errors ? "success" : sync.ok ? "warning" : "danger"}>{sync.ok ? (sync.errors ? "com avisos" : "ok") : "falhou"}</Badge>
                <span className="text-muted">em {when(sync.at)}</span>
              </p>
              {sync.catalog_name && <p>Catálogo: <b>{sync.catalog_name}</b>{sync.product_count != null && ` · ${sync.product_count} itens na Meta`}</p>}
              {sync.items != null && <p className="text-muted">{sync.items} itens no catálogo interno · {sync.sent ?? 0} enviados nesta rodada · {sync.deleted ?? 0} removidos · {sync.errors ?? 0} com erro</p>}
              {sync.error && <p className="text-danger">{sync.error}</p>}
            </div>
          )}
        </Card>
      )}

      <Card title="Passo a passo na Meta" className="mt-4">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>No <a className="underline" href="https://business.facebook.com/commerce" target="_blank" rel="noopener noreferrer">Commerce Manager</a>, crie um catálogo <b>da franquia</b> do tipo <i>E-commerce</i>, sem fonte de dados (o CetraOps preenche). Use o mesmo portfólio empresarial da conta do WhatsApp.</li>
          <li>No <b>WhatsApp Manager</b> › <i>Catálogo</i>, escolha esse catálogo e conecte à conta do WhatsApp (WABA) do número {ch.provider_account_id}. Ali também dá para mostrar o ícone de loja e ativar o carrinho.</li>
          <li>Nas <b>Configurações do negócio</b> › <i>Usuários do sistema</i>, dê ao usuário do token do WhatsApp acesso ao catálogo (controle total) e gere o token com a permissão <code>catalog_management</code>, além de <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code>. Atualize o token na integração da Meta.</li>
          <li>Copie o <b>ID do catálogo</b> (Commerce Manager › Configurações do catálogo) para o campo acima e salve. A sincronização mostra aqui quantos itens subiram e os erros (por exemplo, foto ou link recusados).</li>
          <li>Teste: peça fotos numa conversa de teste e veja a sugestão do copiloto mostrar as peças como <i>catálogo</i>. Itens recém-enviados podem levar alguns minutos para aparecer no WhatsApp.</li>
        </ol>
      </Card>
    </Narrow>
  );
}
