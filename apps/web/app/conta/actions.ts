"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const str = (v: FormDataEntryValue | null) => String(v ?? "");

export async function changePasswordAction(formData: FormData) {
  const nova = str(formData.get("new"));
  const back = (erro: string) => redirect(`/conta?${new URLSearchParams({ erro, ...(formData.get("primeiro") ? { primeiro: "1" } : {}) })}`);
  if (nova !== str(formData.get("confirm"))) back("A confirmação não é igual à nova senha.");
  const supabase = await createClient();
  const { error } = await supabase.schema("core").rpc("change_my_password", { p_current: str(formData.get("current")), p_new: nova });
  if (error) back(error.message.replace(/^ERROR:\s*/, ""));
  redirect("/inicio?ok=Senha%20alterada");
}
