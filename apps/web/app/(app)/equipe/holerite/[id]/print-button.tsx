"use client";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return <Button variant="secondary" onClick={() => window.print()}><Printer size={15} /> Imprimir / salvar PDF</Button>;
}
