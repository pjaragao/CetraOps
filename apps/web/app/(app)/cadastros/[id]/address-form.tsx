"use client";
import { useState } from "react";
import { AddressFields, EMPTY_ADDRESS, type Address } from "@/components/address-fields";
import { Button, inputClass } from "@/components/ui";
import { Field } from "@/components/form";
import { saveAddressAction } from "../actions";

/** Novo endereço com CEP automático (os campos vão para a Server Action com prefixo a_). */
export function AddressForm({ partyId }: { partyId: string }) {
  const [addr, setAddr] = useState<Address>(EMPTY_ADDRESS);
  return (
    <form action={saveAddressAction} className="space-y-3">
      <input type="hidden" name="id" value={partyId} />
      <AddressFields value={addr} onChange={setAddr} namePrefix="a_" />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Apelido (opcional)"><input name="label" maxLength={40} className={`${inputClass} w-48`} placeholder="Casa, trabalho…" /></Field>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="is_default" /> Endereço principal</label>
        <Button variant="secondary">Salvar endereço</Button>
      </div>
    </form>
  );
}
