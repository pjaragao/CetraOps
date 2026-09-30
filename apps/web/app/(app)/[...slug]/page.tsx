import { notFound } from "next/navigation";
import { NAV } from "@sie/domain";
import { Empty, LinkButton, PageHeader } from "@/components/ui";

/** Telas previstas no plano mas ainda não construídas: aviso honesto em vez de tela falsa. */
const ROADMAP: Record<string, string> = {
  "/atendimento/templates": "Sprint B1/B2 (templates do WhatsApp aprovados pela Meta)",
  "/vender/reservas": "Sprint A2 (reservas e Armário VIP)",
  "/vender/trocas": "Sprint A2 (trocas e vale-troca)",
  "/marketing/cupons": "Sprint A2",
  "/produtos/compras": "Sprint A1/A5 (recebimento por XML e reposição por tamanho)",
  "/financeiro/conciliacao": "Sprint A4 (conciliação 3 vias com extratos Inter, BTG e Mercado Pago)",
  "/financeiro/rateios": "Sprint A4", "/financeiro/dre": "Sprint A4", "/financeiro/fluxo": "Sprint A4",
  "/fiscal/emitidas": "Sprint A1 (NFC-e via Focus NFe)", "/fiscal/recebidas": "Sprint A5 (MDe)",
  "/equipe/comissoes": "Sprint A6", "/ia/personas": "Sprint B2 (pipeline de persona)",
  "/configuracoes/integracoes": "Sprint B1/A3",
};

export default async function Planned({ params }: { params: Promise<{ slug: string[] }> }) {
  const path = "/" + (await params).slug.join("/");
  const item = NAV.flatMap((a) => [{ label: a.label, href: a.href }, ...a.items]).find((i) => i.href === path);
  if (!item || !ROADMAP[path]) notFound();
  return (
    <>
      <PageHeader title={item.label} />
      <Empty title="Em construção">
        Esta tela faz parte do plano e chega em: <b>{ROADMAP[path]}</b>.
        <div className="mt-4"><LinkButton href="/inicio">Voltar ao início</LinkButton></div>
      </Empty>
    </>
  );
}
