import { signIn, signOut } from "./actions";

export const metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string; next?: string }> }) {
  const { erro, next } = await searchParams;
  return (
    <main className="min-h-dvh grid place-items-center px-4">
      <form action={signIn} className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">SIÉ JOY</p>
        <h1 className="mt-1 text-2xl font-semibold">Entrar no sistema</h1>
        <p className="mt-1 text-sm text-muted">Acesso por convite. Fale com um sócio se ainda não tem conta.</p>

        {erro && (
          <p role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {erro === "sem-acesso" ? "Sua conta ainda não foi vinculada à empresa." : erro === "sistema" ? "O sistema não conseguiu ler o seu cadastro (banco fora do ar ou desatualizado). Tente de novo em instantes ou avise quem administra o servidor." : "E-mail ou senha inválidos."}
          </p>
        )}

        {erro === "sem-acesso" && (
          <button formAction={signOut} formNoValidate className="mt-3 text-sm text-brand underline">Sair e trocar de conta</button>
        )}

        <input type="hidden" name="next" value={next ?? "/inicio"} />
        <label className="mt-6 block text-sm font-medium" htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" required autoComplete="email"
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 outline-none focus:ring-2 focus:ring-brand" />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">Senha</label>
        <input id="password" name="password" type="password" required autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 outline-none focus:ring-2 focus:ring-brand" />
        <button className="mt-6 w-full rounded-lg bg-brand px-4 py-2.5 font-medium text-brand-contrast hover:opacity-90">
          Entrar
        </button>
      </form>
    </main>
  );
}
