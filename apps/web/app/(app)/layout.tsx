import { Suspense } from "react";
import { redirect } from "next/navigation";
import { visibleNav } from "@sie/domain";
import { getSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPalette } from "@/components/shell/command-palette";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.mustChangePassword) redirect("/conta?primeiro=1");
  const nav = visibleNav(session.perms, session.isSuperuser);
  const supabase = await createClient();
  const { count: unread } = await supabase.schema("core").from("notifications").select("id", { count: "exact", head: true }).eq("member_id", session.memberId).is("read_at", null);

  return (
    <div className="flex min-h-dvh">
      <Sidebar nav={nav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-12 border-b border-border" />}>
          <Topbar
            name={session.name}
            memberId={session.memberId}
            unreadNotifications={unread ?? 0}
            stores={session.stores.map((s) => ({ id: s.id, name: s.name }))}
            storeId={session.storeId}
            canAllStores={session.isSuperuser}
          />
        </Suspense>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
      <CommandPalette nav={nav} />
    </div>
  );
}
