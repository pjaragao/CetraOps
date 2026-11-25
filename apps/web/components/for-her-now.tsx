import { formatBRL } from "@centralops/domain";
import { ForHerAdd } from "./for-her-add";

export interface ForHerNowData {
  sizes: string[]; arrivals: Item[]; matches: Item[]; last_purchase: string | null; reservations: number; store_credit: number;
  interest_waiting: number; birthday_in_days: number | null; events: { name: string; starts_at: string; rsvp: string }[]; tier: string; benefits: string[] | null;
}
interface Item { product_id: string; color_id?: string; color?: string; name: string; size: string; price: number | null }

const RSVP: Record<string, string> = { INVITED: "convidada", CONFIRMED: "confirmou", WAITLIST: "lista de espera", DECLINED: "não vai" };

/** "Para ela agora" (crm.for_her_now): o que oferecer e lembrar nesta conversa. Com `cart`, cada sugestão ganha o "+" que a põe no carrinho da conversa. */
export function ForHerNow({ data, compact = false, cart }: {
  data: ForHerNowData; compact?: boolean; cart?: { conversationId: string; items: { product_id: string; color_id?: string }[] };
}) {
  const list = (items: Item[]) => (
    <ul className="space-y-0.5">{items.slice(0, compact ? 3 : 6).map((i) => (
      <li key={i.product_id} className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate" title={i.color ? `${i.name} · ${i.color}` : i.name}>{i.name} · <b>{i.size}</b></span>
        <span className="flex shrink-0 items-center gap-1">
          {i.price != null && <span className="tabular-nums text-muted">{formatBRL(Number(i.price))}</span>}
          {cart && <ForHerAdd conversationId={cart.conversationId} productId={i.product_id} colorId={i.color_id} size={i.size} name={i.name}
            inCart={cart.items.some((c) => c.product_id === i.product_id && (!i.color_id || c.color_id === i.color_id))} />}
        </span>
      </li>
    ))}</ul>
  );
  const facts = [
    data.birthday_in_days != null && data.birthday_in_days <= 15 ? (data.birthday_in_days === 0 ? "Aniversário hoje 🎂" : `Aniversário em ${data.birthday_in_days} dia(s)`) : null,
    Number(data.store_credit) > 0 ? `Vale-troca de ${formatBRL(Number(data.store_credit))}` : null,
    data.reservations > 0 ? `${data.reservations} peça(s) reservada(s)` : null,
    data.interest_waiting > 0 ? `${data.interest_waiting} avise-me aguardando` : null,
    ...data.events.map((e) => `${e.name} (${RSVP[e.rsvp] ?? e.rsvp})`),
  ].filter(Boolean) as string[];
  return (
    <div className="space-y-2 text-sm">
      {facts.length > 0 && <ul className="space-y-0.5">{facts.map((f) => <li key={f}>• {f}</li>)}</ul>}
      <div>
        <p className="text-xs text-muted">Novidades no tamanho dela{data.sizes.length ? ` (${data.sizes.join(", ")})` : ""}</p>
        {data.sizes.length === 0 ? <p className="text-xs text-muted">Tamanho não cadastrado: pergunte e anote na ficha.</p> : data.arrivals.length === 0 ? <p className="text-xs text-muted">Nada novo com estoque.</p> : list(data.arrivals)}
      </div>
      {data.last_purchase && (
        <div>
          <p className="text-xs text-muted">Combina com a última compra ({data.last_purchase})</p>
          {data.matches.length === 0 ? <p className="text-xs text-muted">Sem sugestão com estoque.</p> : list(data.matches)}
        </div>
      )}
      {!compact && data.benefits && data.benefits.length > 0 && (
        <div><p className="text-xs text-muted">Benefícios do nível dela</p><ul className="text-xs">{data.benefits.map((b) => <li key={b}>• {b}</li>)}</ul></div>
      )}
    </div>
  );
}
