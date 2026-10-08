import { redirect } from "next/navigation";

/** A tela de afiliadas mudou para Marketing; o endereço antigo continua valendo. */
export default function Page() {
  redirect("/marketing/afiliadas");
}
