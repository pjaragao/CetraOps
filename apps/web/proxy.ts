import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Renova a sessão do Supabase a cada request e protege as rotas do app (tudo exceto /login). */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const isLogin = request.nextUrl.pathname.startsWith("/login");
  // públicos sem login: link curto e avisos de provedores (o aviso só pede uma conferência na API do provedor; não confia no corpo);
  // /api/pos/ é o app da maquininha: cada rota exige o token da maquininha pareada e o JWT do operador (lib/pos-api.ts)
  if (request.nextUrl.pathname.startsWith("/r/") || request.nextUrl.pathname.startsWith("/api/webhooks/") || request.nextUrl.pathname === "/api/internal/stone-drain"
      || request.nextUrl.pathname.startsWith("/api/pos/")) return response;

  if (!data?.claims && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";   // o destino vai inteiro no next (com ?id=… da notificação), não solto nos parâmetros do login
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  // Sessão válida mas sem vínculo com a empresa (?erro=sem-acesso): deixa a tela de login aparecer para trocar de conta
  if (data?.claims && ((isLogin && !request.nextUrl.searchParams.has("erro")) || request.nextUrl.pathname === "/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/inicio";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
