import { notFound } from "next/navigation";
import { NAV } from "@sie/domain";
import { Empty, LinkButton, PageHeader } from "@/components/ui";

/** Telas previstas no plano mas ainda não construídas: aviso honesto em vez de tela falsa. */
const ROADMAP: Record<string, string> = {};   // todas as telas do menu já existem; novas entradas planejadas entram aqui (caminho → sprint)

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
