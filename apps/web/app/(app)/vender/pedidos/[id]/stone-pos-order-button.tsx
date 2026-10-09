"use client";

import { useState } from "react";
import { Smartphone } from "lucide-react";
import { formatBRL } from "@centralops/domain";
import { Button } from "@/components/ui";
import { StonePosDialog } from "../../stone-pos-dialog";

interface StonePosOrderButtonProps {
  orderId: string;
  orderNumber: string;
  balance: number;
  customerName?: string;
}

export function StonePosOrderButton({
  orderId,
  orderNumber,
  balance,
  customerName,
}: StonePosOrderButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5"
      >
        <Smartphone size={16} className="text-brand" />
        Cobrar na Maquininha Stone ({formatBRL(balance)})
      </Button>

      <StonePosDialog
        open={open}
        onClose={() => setOpen(false)}
        amount={balance}
        orderId={orderId}
        orderNumber={orderNumber}
        customerName={customerName}
      />
    </>
  );
}
