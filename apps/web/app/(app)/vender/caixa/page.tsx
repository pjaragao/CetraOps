import { revalidatePath } from "next/cache";
import { formatBRL } from "@sie/domain";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/session";
import { Button, Card, Empty, inputClass, PageHeader, Table } from "@/components/ui";

export const metadata = { title: "Caixa" };

async function openSession(formData: FormData) {
  "use server";
  const supabase = await createClient();
  await supabase.schema("sales").rpc("open_cash_session", {
    p_register: String(formData.get("register")), p_opening_float: Number(formData.get("float") || 0),
  });
  revalidatePath("/vender/caixa");
}

async function movement(formData: FormData) {
  "use server";
  const supabase = await createClient();
  await supabase.schema("sales").rpc("cash_movement", {
    p_session: String(formData.get("session")), p_type: String(formData.get("type")),
    p_amount: Number(String(formData.get("amount")).replace(",", ".")), p_reason: String(formData.get("reason") || ""),
  });
  revalidatePath("/vender/caixa");
}

async function closeSession(formData: FormData) {
  "use server";
  const supabase = await createClient();
  await supabase.schema("sales").rpc("close_cash_session", {
    p_session: String(formData.get("session")), p_counted: Number(String(formData.get("counted")).replace(",", ".")),
    p_notes: String(formData.get("notes") || ""),
  });
  revalidatePath("/vender/caixa");
}

export default async function CaixaPage() {
  const session = await requirePerm("sales.write");
  const supabase = await createClient();
  if (!session.storeId) return (<><PageHeader title="Caixa" /><Empty title="Escolha uma loja no topo" /></>);

  const [{ data: registers }, { data: open }, { data: history }] = await Promise.all([
    supabase.schema("sales").from("cash_registers").select("id, name").eq("store_id", session.storeId).eq("active", true),
    supabase.schema("sales").from("cash_sessions").select("id, opened_at, opening_float, register_id").eq("store_id", session.storeId).eq("status", "OPEN").maybeSingle(),
    supabase.schema("sales").from("cash_sessions").select("id, opened_at, closed_at, expected_cash, counted_cash, difference").eq("store_id", session.storeId).eq("status", "CLOSED").order("closed_at", { ascending: false }).limit(10),
  ]);
  const { data: moves } = open
    ? await supabase.schema("sales").from("cash_session_movements").select("id, type, amount, reason, created_at").eq("session_id", open.id).order("created_at")
    : { data: [] };
  const expected = open ? Number(open.opening_float) + (moves ?? []).reduce((a, m) => a + Number(m.amount), 0) : 0;

  return (
    <>
      <PageHeader title="Caixa" description="Abertura, suprimento, sangria e fechamento cego da gaveta." />
      {!open ? (
        <Card title="Abrir caixa" className="max-w-md">
          <form action={openSession} className="space-y-3">
            <select name="register" className={inputClass} aria-label="Caixa">{(registers ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <input name="float" inputMode="decimal" placeholder="Fundo de troco (R$)" className={inputClass} aria-label="Fundo de troco" />
            <Button>Abrir caixa</Button>
          </form>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={`Caixa aberto desde ${new Date(open.opened_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`}>
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between"><span>Fundo de troco</span><span>{formatBRL(open.opening_float)}</span></li>
              {(moves ?? []).map((m) => (
                <li key={m.id} className="flex justify-between"><span>{m.type}{m.reason ? ` · ${m.reason}` : ""}</span><span>{formatBRL(m.amount)}</span></li>
              ))}
            </ul>
            <form action={movement} className="mt-4 grid grid-cols-2 gap-2">
              <input type="hidden" name="session" value={open.id} />
              <select name="type" className={inputClass} aria-label="Tipo"><option value="SANGRIA">Sangria</option><option value="SUPRIMENTO">Suprimento</option></select>
              <input name="amount" inputMode="decimal" required placeholder="Valor" className={inputClass} aria-label="Valor" />
              <input name="reason" placeholder="Motivo" className={`${inputClass} col-span-2`} aria-label="Motivo" />
              <Button variant="secondary" className="col-span-2">Registrar</Button>
            </form>
          </Card>
          <Card title="Fechar caixa (cego)">
            <p className="mb-3 text-sm text-muted">Conte a gaveta e informe o valor. O sistema compara com o esperado depois de fechar.</p>
            <form action={closeSession} className="space-y-3">
              <input type="hidden" name="session" value={open.id} />
              <input name="counted" inputMode="decimal" required placeholder="Valor contado (R$)" className={inputClass} aria-label="Valor contado" />
              <input name="notes" placeholder="Observações" className={inputClass} aria-label="Observações" />
              <Button variant="danger">Fechar caixa</Button>
            </form>
            {session.isSuperuser && <p className="mt-3 text-xs text-muted">Esperado agora (visível só para sócios): {formatBRL(expected)}</p>}
          </Card>
        </div>
      )}

      <h2 className="mt-8 mb-2 text-sm font-semibold text-muted">Últimos fechamentos</h2>
      {(history ?? []).length === 0 ? <Empty title="Nenhum fechamento ainda" /> : (
        <Table head={["Fechado em", "Esperado", "Contado", "Diferença"]}>
          {(history ?? []).map((h) => (
            <tr key={h.id}>
              <td className="px-3 py-2">{h.closed_at && new Date(h.closed_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
              <td className="px-3 py-2">{formatBRL(h.expected_cash)}</td>
              <td className="px-3 py-2">{formatBRL(h.counted_cash)}</td>
              <td className={`px-3 py-2 font-medium ${Number(h.difference) === 0 ? "text-success" : "text-danger"}`}>{formatBRL(h.difference)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
