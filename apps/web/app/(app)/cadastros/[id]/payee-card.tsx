import { Button, Card, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { setPayeeDefaultsAction } from "../actions";

export const PAYEE_KIND: Record<string, string> = {
  TAX_FEDERAL: "Tributo federal", TAX_STATE: "Tributo estadual", TAX_MUNICIPAL: "Tributo municipal", PAYROLL_CHARGE: "Encargo da folha",
  UTILITY: "Concessionária (energia, água, gás)", TELECOM: "Telefonia e internet", LOGISTICS: "Frete e envio", INTERMEDIARY: "Banco / intermediador (recebe por outros)", OTHER: "Outro",
};

/** Como a empresa aparece nas contas a pagar: tipo de favorecido e categoria padrão. */
export function PayeeCard({ id, kind, account, notes, accounts, canWrite }: {
  id: string; kind: string | null; account: string | null; notes: string | null; accounts: { id: string; label: string }[]; canWrite: boolean;
}) {
  return (
    <Card title="Como favorecido (contas a pagar)">
      {notes && <p className="mb-2 text-sm text-muted">{notes}</p>}
      <form action={setPayeeDefaultsAction} className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <input type="hidden" name="id" value={id} />
        <Field label="Tipo"><select name="payee_kind" defaultValue={kind ?? ""} disabled={!canWrite} className={inputClass}><option value="">—</option>{Object.entries(PAYEE_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Categoria padrão" hint="Usada quando a conta é lançada sem escolher a categoria"><select name="account" defaultValue={account ?? ""} disabled={!canWrite} className={inputClass}><option value="">— nenhuma —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
        {canWrite && <Button variant="secondary" className="w-fit">Salvar</Button>}
      </form>
    </Card>
  );
}
