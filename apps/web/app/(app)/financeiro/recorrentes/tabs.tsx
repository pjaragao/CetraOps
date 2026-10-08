import Link from "next/link";
import { cn } from "@/components/ui";

const TABS = [
  { key: "recorrentes", href: "/financeiro/recorrentes", label: "Recorrências mensais", help: "Valor fixo todo mês, sem prazo (aluguel, contabilidade, software): o sistema gera a conta de cada mês." },
  { key: "contratos", href: "/financeiro/contratos", label: "Contratos com cronograma", help: "Prazo fechado com parcelas, meses pagos em peças e contrapartidas (ex.: patrocínio e licença de espaço)." },
  { key: "emprestimos", href: "/financeiro/emprestimos", label: "Empréstimos e financiamentos", help: "Dinheiro que entra agora e volta em parcelas com juros: o sistema lança a entrada e todas as parcelas." },
] as const;

/** Um módulo, três jeitos de compromisso que se repete: abas comuns às três telas. */
export function CommitmentTabs({ current }: { current: (typeof TABS)[number]["key"] }) {
  const tab = TABS.find((t) => t.key === current)!;
  return (
    <div className="mb-4">
      <nav className="flex flex-wrap gap-1.5" aria-label="Contratos e recorrências">
        {TABS.map((t) => (
          <Link key={t.key} href={t.href} aria-current={t.key === current ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1 text-sm", t.key === current ? "border-brand bg-brand/10 text-brand" : "border-border hover:bg-surface-2")}>{t.label}</Link>
        ))}
      </nav>
      <p className="mt-2 text-xs text-muted">{tab.help}</p>
    </div>
  );
}
