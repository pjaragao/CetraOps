"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui";

/** Botão de envio que pergunta antes (excluir relatório). */
export function ConfirmButton({ children, question }: { children: ReactNode; question: string }) {
  return <Button variant="ghost" className="text-danger" onClick={(e) => { if (!window.confirm(question)) e.preventDefault(); }}>{children}</Button>;
}
