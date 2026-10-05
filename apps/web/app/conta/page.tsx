import Link from "next/link";
import { getSession } from "@/lib/session";
import { signOut } from "@/app/login/actions";
import { changePasswordAction } from "./actions";

export const metadata = { title: "Minha conta" };

const input = "mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 outline-none focus:ring-2 focus:ring-brand";

export default async function ContaPage({ searchParams }: { searchParams: Promise<{ erro?: string; primeiro?: string }> }) {
  const session = await getSession();
  const { erro, primeiro } = await searchParams;
  const first = session.mustChangePassword || primeiro === "1";
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <form action={changePasswordAction} className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">CentralOps</p>
        <h1 className="mt-1 text-2xl font-semibold">{first ? "Crie sua senha" : "Trocar a senha"}</h1>
        <p className="mt-1 text-sm text-muted">
          {first ? `Olá, ${session.name.split(" ")[0]}! Você entrou com uma senha provisória. Escolha a sua para continuar.` : `Conta de ${session.name}.`}
        </p>
        {erro && <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{erro}</p>}
        {first && <input type="hidden" name="primeiro" value="1" />}
        <label className="mt-6 block text-sm font-medium" htmlFor="current">{first ? "Senha provisória" : "Senha atual"}</label>
        <input id="current" name="current" type="password" required autoComplete="current-password" className={input} />
        <label className="mt-4 block text-sm font-medium" htmlFor="new">Nova senha</label>
        <input id="new" name="new" type="password" required minLength={8} autoComplete="new-password" className={input} />
        <p className="mt-1 text-xs text-muted">Ao menos 8 caracteres, com letras e números.</p>
        <label className="mt-4 block text-sm font-medium" htmlFor="confirm">Repita a nova senha</label>
        <input id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" className={input} />
        <button className="mt-6 w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-brand-contrast hover:opacity-90">Salvar senha</button>
        <div className="mt-4 flex justify-between text-sm">
          {first ? <span /> : <Link href="/inicio" className="text-brand">Voltar</Link>}
          <button formAction={signOut} formNoValidate className="text-muted underline">Sair</button>
        </div>
      </form>
    </main>
  );
}
