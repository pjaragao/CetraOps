"use client";
import { formatBRL } from "@centralops/domain";
import { SearchPicker } from "@/components/search-picker";
import { searchParties, searchSellable, type SellableHit } from "./actions";

export interface PartyHit { id: string; name: string; phone: string | null }

export function PartyPicker({ onPick, placeholder = "Buscar cliente por nome ou telefone" }: { onPick: (p: PartyHit) => void; placeholder?: string }) {
  return <SearchPicker<PartyHit> search={searchParties} onPick={onPick} placeholder={placeholder} label="Buscar cliente"
    render={(p) => <span><span className="font-medium">{p.name}</span>{p.phone && <span className="ml-2 text-xs text-muted">{p.phone}</span>}</span>} />;
}

export function SellablePicker({ onPick, locationId, placeholder = "Adicionar peça: SKU, EAN ou nome" }: { onPick: (v: SellableHit) => void; locationId?: string; placeholder?: string }) {
  return <SearchPicker<SellableHit> search={(q) => searchSellable(q, locationId)} onPick={onPick} placeholder={placeholder} label="Buscar peça"
    render={(v) => (
      <span className="flex items-center justify-between gap-3">
        <span><span className="font-mono text-xs text-muted">{v.sku}</span> {v.label}</span>
        <span className="whitespace-nowrap text-xs">{v.price != null ? formatBRL(v.price) : <span className="text-danger">sem preço</span>} · <span className={v.available > 0 ? "text-success" : "text-danger"}>{v.available > 0 ? `${v.available} disp.` : "sem estoque"}</span></span>
      </span>
    )} />;
}
