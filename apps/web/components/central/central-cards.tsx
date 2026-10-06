"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, X } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Badge, Button, cn } from "@/components/ui";
import { cancelCentralAction, confirmCentralAction } from "@/app/(app)/central/actions";
import type { ActionCardData, Card } from "@/lib/central/cards";

const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

function Frame({ title, children, href, tone }: { title: string; children: React.ReactNode; href?: string; tone?: "brand" }) {
  return (
    <div className={cn("rounded-xl border bg-surface p-3", tone === "brand" ? "border-brand/40" : "border-border")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted">{title}</p>
        {href && <Link href={href} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">abrir <ExternalLink size={12} /></Link>}
      </div>
      {children}
    </div>
  );
}

function ActionCard({ action: initial }: { action: ActionCardData }) {
  const [a, setA] = useState(initial);
  const [pending, start] = useTransition();
  const expired = a.status === "PROPOSED" && new Date(a.expires_at) < new Date();
  const status = expired ? "EXPIRED" : a.status;
  const run = (fn: typeof confirmCentralAction) => start(async () => {
    const r = await fn(a.id);
    setA((x) => ({ ...x, status: r.status, result: r.result ?? null, error: r.error ?? null }));
  });
  return (
    <Frame title={a.title} tone="brand">
      <dl className="space-y-1 text-sm">
        {a.lines.map((l, i) => (
          <div key={i} className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted">{l.label}</dt>
            <dd className="text-right font-medium">{l.value}</dd>
          </div>
        ))}
        {a.total !== undefined && a.total !== null && (
          <div className="mt-1 flex justify-between gap-3 border-t border-border pt-1 text-base">
            <dt className="font-semibold">Total (calculado pelo sistema)</dt>
            <dd className="font-semibold">{formatBRL(a.total)}</dd>
          </div>
        )}
      </dl>
      {a.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {a.warnings.map((w, i) => <li key={i} className="flex gap-1.5 text-xs text-warning"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{w}</li>)}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {status === "PROPOSED" && (
          <>
            <Button onClick={() => run(confirmCentralAction)} disabled={pending} aria-label={`Confirmar: ${a.title}`}>
              {pending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Confirmar
            </Button>
            <Button variant="secondary" onClick={() => run(cancelCentralAction)} disabled={pending}><X size={15} /> Cancelar</Button>
            <span className="text-xs text-muted">vale até {new Date(a.expires_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
          </>
        )}
        {status === "EXECUTED" && (
          <p className="flex items-center gap-2 text-sm text-success">
            <Check size={15} /> {a.result?.text ?? "Feito."}
            {a.result?.href && <Link href={a.result.href} className="text-brand hover:underline">ver</Link>}
          </p>
        )}
        {status === "FAILED" && <p className="text-sm text-danger">Não foi feito: {a.error}</p>}
        {status === "CANCELLED" && <Badge>cancelado</Badge>}
        {status === "EXPIRED" && <Badge tone="warning">expirou: peça de novo</Badge>}
      </div>
    </Frame>
  );
}

/** Um cartão da Central. `onPick` manda a escolha da pessoa de volta à conversa (com o id entre colchetes). */
export function CentralCard({ card, onPick }: { card: Card; onPick?: (text: string) => void }) {
  switch (card.kind) {
    case "acao":
      return <ActionCard action={card.action} />;
    case "clientes":
      return (
        <Frame title={card.title}>
          <ul className="divide-y divide-border">
            {card.items.map((p) => (
              <li key={p.party_id} className="flex items-center justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted">
                    {[p.city, p.phone_last4 && `tel. …${p.phone_last4}`, p.cpf_last4 && `CPF …${p.cpf_last4}`, p.last_purchase_at && `última compra ${fmtDate(p.last_purchase_at)}`].filter(Boolean).join(" · ") || "sem detalhes"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {onPick && card.items.length > 1 && <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => onPick(`É esta: ${p.name} [party_id=${p.party_id}]`)}>É esta</Button>}
                  <Link href={`/clientes/${p.party_id}`} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label={`Abrir ficha de ${p.name}`}><ExternalLink size={14} /></Link>
                </div>
              </li>
            ))}
          </ul>
        </Frame>
      );
    case "ficha":
      return (
        <Frame title={card.name} href={card.href}>
          <dl className="space-y-1 text-sm">
            {card.lines.map((l, i) => <div key={i} className="flex justify-between gap-3"><dt className="text-muted">{l.label}</dt><dd className="text-right">{l.value}</dd></div>)}
          </dl>
        </Frame>
      );
    case "produtos":
      return (
        <Frame title={card.title}>
          <div className="space-y-3">
            {card.items.map((p) => {
              const colors = [...new Set(p.variants.map((v) => v.color ?? ""))];
              return (
                <div key={p.product_id}>
                  <p className="text-sm font-medium">{p.name} <span className="text-xs font-normal text-muted">{p.reference}</span></p>
                  {colors.map((c) => (
                    <div key={c} className="mt-1 flex flex-wrap items-center gap-1.5">
                      {c && <span className="w-20 shrink-0 truncate text-xs text-muted">{c}</span>}
                      {p.variants.filter((v) => (v.color ?? "") === c).map((v) => (
                        <button
                          key={v.variant_id}
                          disabled={!onPick}
                          onClick={() => onPick?.(`Quero ${p.name}${v.color ? ` ${v.color}` : ""} tamanho ${v.size} [variant_id=${v.variant_id}]`)}
                          title={`${v.sku} · ${v.price !== null ? formatBRL(v.price) : "sem preço"} · ${v.available} disponível`}
                          className={cn("min-w-10 rounded-lg border px-2 py-1 text-xs font-medium",
                            v.available > 0 ? "border-border hover:border-brand hover:text-brand" : "border-dashed border-border text-muted/60 line-through")}
                        >
                          {v.size}<span className="block text-[10px] font-normal text-muted">{v.available}</span>
                        </button>
                      ))}
                      <span className="text-xs text-muted">{p.variants.find((v) => (v.color ?? "") === c)?.price != null ? formatBRL(p.variants.find((v) => (v.color ?? "") === c)!.price) : ""}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </Frame>
      );
    case "titulos":
      return (
        <Frame title={card.title} href={card.href}>
          {card.items.length === 0 ? <p className="text-sm text-muted">Nenhuma conta neste período.</p> : (
            <>
              <ul className="divide-y divide-border text-sm">
                {card.items.slice(0, 12).map((t) => (
                  <li key={t.installment_id} className="flex items-center justify-between gap-2 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.party ?? t.description}</p>
                      <p className="truncate text-xs text-muted">{t.description} · vence {fmtDate(t.due_date)}{t.overdue_days > 0 ? ` · ${t.overdue_days} dia(s) de atraso` : ""}{!t.approved ? " · sem aprovação" : ""}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={cn("font-medium", t.overdue_days > 0 && "text-danger")}>{formatBRL(t.balance)}</span>
                      {onPick && card.direction === "PAYABLE" && t.approved && (
                        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => onPick(`Pagar esta conta: ${t.party ?? t.description} [installment_id=${t.installment_id}]`)}>Pagar</Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {card.items.length > 12 && <p className="mt-1 text-xs text-muted">e mais {card.items.length - 12} na tela.</p>}
              <p className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-semibold"><span>{card.items.length} conta(s)</span><span>{formatBRL(card.total)}</span></p>
            </>
          )}
        </Frame>
      );
    case "saldos":
      return (
        <Frame title="Saldos" href="/financeiro">
          <ul className="space-y-1 text-sm">
            {card.items.map((b, i) => <li key={i} className="flex justify-between"><span className="text-muted">{b.name}</span><span className={cn("font-medium", b.balance < 0 && "text-danger")}>{formatBRL(b.balance)}</span></li>)}
          </ul>
          <p className="mt-2 flex justify-between border-t border-border pt-2 text-sm font-semibold"><span>Total</span><span>{formatBRL(card.total)}</span></p>
        </Frame>
      );
    case "numeros":
      return (
        <Frame title={card.title} href={card.href}>
          <dl className="space-y-1 text-sm">
            {card.items.map((l, i) => <div key={i} className="flex justify-between gap-3"><dt className="text-muted">{l.label}</dt><dd className="text-right font-medium">{l.value}</dd></div>)}
          </dl>
        </Frame>
      );
    case "lista":
      return (
        <Frame title={card.title}>
          {card.items.length === 0 ? <p className="text-sm text-muted">Nada por aqui.</p> : (
            <ul className="space-y-1 text-sm">
              {card.items.map((it, i) => (
                <li key={i}>
                  {it.href ? <Link href={it.href} className="font-medium hover:underline">{it.title}</Link> : <span className="font-medium">{it.title}</span>}
                  {it.detail && <span className="block text-xs text-muted">{it.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </Frame>
      );
    case "links":
      return (
        <div className="flex flex-wrap gap-2">
          {card.items.map((l) => <Link key={l.href} href={l.href} className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2">{l.label} <ExternalLink size={12} /></Link>)}
        </div>
      );
  }
}
