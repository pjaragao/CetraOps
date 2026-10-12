"use client";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ASSISTANT_NAME, briefingLine, type BriefingItem } from "@centralops/domain";
import { Card, cn } from "@/components/ui";

/** Resumo do dia no Início (números do banco, conforme as permissões de quem vê). A conversa sobre ele abre a Central. */
export function BriefingCard({ items, central }: { items: BriefingItem[]; central: boolean }) {
  return (
    <Card title="Resumo do dia" action={central ? (
      <button onClick={() => window.dispatchEvent(new CustomEvent("centralops:central", { detail: { text: "Me explica o resumo do dia: o que eu devo fazer primeiro?" } }))}
              className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
        <Sparkles size={13} /> Conversar com a {ASSISTANT_NAME}
      </button>
    ) : undefined}>
      {items.length === 0 ? <p className="text-sm text-muted">Nada pedindo atenção agora.</p> : (
        <ul className="space-y-1.5 text-sm">
          {items.map((i) => (
            <li key={i.key} className="flex items-start gap-2">
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", i.tone === "danger" ? "bg-danger" : i.tone === "warning" ? "bg-warning" : "bg-muted/40")} aria-hidden />
              <Link href={i.href === "/inicio" ? "#lista-do-dia" : i.href} className="hover:underline">{briefingLine(i)}</Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
