import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";
import { PrintButtonBar } from "../../print-button-bar";

export const metadata = { title: "DANFE NFC-e" };

interface Danfe {
  emit: { razao_social: string; fantasia?: string; cnpj: string; ie?: string; endereco: string };
  items: { codigo: string; descricao: string; qtd: string; un: string; vun: string; vtot: string }[];
  vProd: string; vDesc: string; vFrete: string; vOutro: string; vNF: string; troco: string;
  pagamentos: { label: string; valor: string }[];
  access_key: string; number: number; series: number; dh_emi: string; tp_amb: number; qr_url: string; url_chave: string;
  cpf?: string | null; protocol?: string; dh_recbto?: string;
  tributos?: { federal: string; estadual: string; municipal: string; total: string; fonte: string } | null;
}

const brl = (v: string | number) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cnpjFmt = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const cpfFmt = (c: string) => c.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");

/** DANFE NFC-e (Manual de Especificações Técnicas do DANFE NFC-e e QR Code) para impressora térmica de 80 mm. */
export default async function DanfeNfce({ params }: { params: Promise<{ id: string }> }) {
  await getSession();
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.schema("sales").rpc("get_nfce_print", { p_document: id });
  const doc = data as { status: string; protocol?: string; danfe: Danfe } | null;
  if (!doc) notFound();
  const d = doc.danfe;
  const qr = await QRCode.toDataURL(d.qr_url, { errorCorrectionLevel: "M", margin: 1, width: 220 });
  const acrescimos = Number(d.vFrete) + Number(d.vOutro);
  const homolog = d.tp_amb === 2;
  const small = { fontSize: "7.5pt" } as const;

  return (
    <div className="mx-auto bg-white p-2 text-black" style={{ width: "76mm", fontFamily: "Arial, sans-serif", fontSize: "8pt" }}>
      <style>{"@page { size: 80mm auto; margin: 2mm } @media print { body { margin: 0 } }"}</style>
      <PrintButtonBar />
      {doc.status === "CANCELLED" && <p className="mb-1 border border-black text-center font-bold">NFC-e CANCELADA</p>}

      {/* Divisão I: emitente */}
      <div className="text-center">
        <p className="font-bold">{d.emit.razao_social}</p>
        <p style={small}>CNPJ {cnpjFmt(d.emit.cnpj)}{d.emit.ie ? ` · IE ${d.emit.ie}` : ""}</p>
        <p style={small}>{d.emit.endereco}</p>
      </div>
      <hr className="my-1 border-dashed border-black" />
      {/* Divisão II: identificação */}
      <p className="text-center font-bold" style={small}>DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</p>
      <hr className="my-1 border-dashed border-black" />

      {/* Divisão III: itens */}
      <table className="w-full" style={small}>
        <thead><tr className="text-left"><th>Código</th><th>Descrição</th><th className="text-right">Qtde</th><th>Un</th><th className="text-right">Vl Unit</th><th className="text-right">Vl Total</th></tr></thead>
        <tbody>
          {d.items.map((i, n) => (
            <tr key={n} className="align-top"><td className="pr-1">{i.codigo}</td><td>{i.descricao}</td><td className="text-right">{i.qtd}</td><td className="pl-1">{i.un}</td><td className="text-right">{brl(i.vun)}</td><td className="text-right">{brl(i.vtot)}</td></tr>
          ))}
        </tbody>
      </table>
      <hr className="my-1 border-dashed border-black" />

      {/* Divisão IV: totais e pagamento */}
      <div className="flex justify-between"><span>Qtde. total de itens</span><span>{d.items.length}</span></div>
      <div className="flex justify-between"><span>Valor total R$</span><span>{brl(d.vProd)}</span></div>
      {Number(d.vDesc) > 0 && <div className="flex justify-between"><span>Desconto R$</span><span>{brl(d.vDesc)}</span></div>}
      {acrescimos > 0 && <div className="flex justify-between"><span>Acréscimos R$</span><span>{brl(acrescimos)}</span></div>}
      <div className="flex justify-between font-bold"><span>Valor a Pagar R$</span><span>{brl(d.vNF)}</span></div>
      <div className="mt-1 flex justify-between font-bold" style={small}><span>FORMA DE PAGAMENTO</span><span>VALOR PAGO R$</span></div>
      {d.pagamentos.map((p, n) => <div key={n} className="flex justify-between"><span>{p.label}</span><span>{brl(p.valor)}</span></div>)}
      {Number(d.troco) > 0 && <div className="flex justify-between"><span>Troco R$</span><span>{brl(d.troco)}</span></div>}
      {d.tributos && (
        <p className="mt-1" style={small}>
          Tributos Totais Incidentes (Lei Federal 12.741/2012): R$ {brl(d.tributos.total)} — Federal R$ {brl(d.tributos.federal)}, Estadual R$ {brl(d.tributos.estadual)}
          {Number(d.tributos.municipal) > 0 ? `, Municipal R$ ${brl(d.tributos.municipal)}` : ""}. Fonte: {d.tributos.fonte}
        </p>
      )}
      <hr className="my-1 border-dashed border-black" />

      {/* Divisão V: mensagem fiscal e chave */}
      <div className="text-center" style={small}>
        {homolog && <p className="font-bold">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL</p>}
        <p className="font-bold">NFC-e nº {String(d.number).padStart(9, "0")} Série {String(d.series).padStart(3, "0")} {when(d.dh_emi)}</p>
        <p>Consulte pela Chave de Acesso em</p>
        <p className="break-all">{d.url_chave}</p>
        <p className="mt-0.5 font-mono">{d.access_key.replace(/(\d{4})/g, "$1 ").trim()}</p>
      </div>
      <hr className="my-1 border-dashed border-black" />
      {/* Divisão VI: consumidor */}
      <p className="text-center" style={small}>{d.cpf ? `CONSUMIDOR - CPF ${cpfFmt(d.cpf)}` : "CONSUMIDOR NÃO IDENTIFICADO"}</p>
      <hr className="my-1 border-dashed border-black" />
      {/* Divisão VII: QR Code e protocolo */}
      <div className="text-center" style={small}>
        <p>Consulta via leitor de QR Code</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="QR Code da NFC-e" className="mx-auto my-1" style={{ width: "30mm", height: "30mm" }} />
        {doc.protocol || d.protocol ? <p>Protocolo de autorização: {doc.protocol ?? d.protocol}<br />Data de autorização: {when(d.dh_recbto)}</p> : <p className="font-bold">NFC-e ainda não autorizada</p>}
      </div>
    </div>
  );
}
