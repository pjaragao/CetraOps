import "server-only";
import { z } from "zod";
import { formatBRL } from "@centralops/domain";
import type { ActionLine } from "./cards";
import { dbError, fail, fmtDate, id, propose, tool, type ToolDef } from "./tool-kit";

/**
 * Ferramentas de COMPRAS na Central: notas fiscais em recebimento e o vínculo dos itens da nota com o catálogo.
 * Ligar e cadastrar só por cartão (vincular_nota); conferir, contar e lançar no estoque continuam na tela do recebimento.
 */

const STATUS: Record<string, string> = { PENDING_CHECK: "aguardando conferência", CHECKED: "conferida, falta lançar", POSTED: "lançada no estoque", DISCARDED: "descartada" };

const notasPendentes = tool({
  name: "notas_pendentes",
  description: "Notas fiscais de compra em recebimento que ainda não entraram no estoque, com quantos itens já estão ligados a peças do catálogo.",
  perms: ["purch.read"],
  status: "Procurando notas em recebimento…",
  input: z.object({}),
  async run(_a, ctx) {
    const { data: rcs, error } = await ctx.supabase.schema("purch").from("receipts").select("id, number, supplier_party_id, status, nf_total, created_at")
      .in("status", ["PENDING_CHECK", "CHECKED"]).order("created_at", { ascending: false }).limit(20);
    dbError(error);
    if (!rcs?.length) return { notas: [], aviso: "nenhuma nota em recebimento: importe o XML da NF-e em Produtos › Recebimento (ou bipe a chave da nota aqui)" };
    const [{ data: items }, { data: parties }] = await Promise.all([
      ctx.supabase.schema("purch").from("receipt_items").select("receipt_id, variant_id").in("receipt_id", rcs.map((r) => r.id)),
      ctx.supabase.schema("crm").from("parties").select("id, display_name").in("id", [...new Set(rcs.map((r) => r.supplier_party_id).filter(Boolean))] as string[]),
    ]);
    const name = new Map((parties ?? []).map((p) => [p.id, p.display_name]));
    const notas = rcs.map((r) => {
      const its = (items ?? []).filter((i) => i.receipt_id === r.id);
      return { receipt_id: r.id, numero: r.number, fornecedor: name.get(r.supplier_party_id ?? "") ?? null, situacao: STATUS[r.status] ?? r.status, total: Number(r.nf_total ?? 0),
               itens: its.length, ligados: its.filter((i) => i.variant_id).length, recebida_em: fmtDate(r.created_at) };
    });
    ctx.addCard({ kind: "lista", title: "Notas em recebimento", items: notas.map((n) => ({ title: `NF-e ${n.numero} · ${n.fornecedor ?? "fornecedor"}`,
      detail: `${n.situacao} · ${n.ligados}/${n.itens} itens ligados · ${formatBRL(n.total)}`, href: `/produtos/recebimento/${n.receipt_id}` })) });
    return { notas };
  },
});

const itensNota = tool({
  name: "itens_nota",
  description: "Itens de uma nota em recebimento (receipt_id de notas_pendentes): descrição e código do fornecedor, EAN, NCM, quantidade, custo e a peça do catálogo já ligada (se houver). Use antes de propor_vinculo_nota; para achar a peça de cada item use buscar_produto pela referência/nome.",
  perms: ["purch.read"],
  status: "Lendo os itens da nota…",
  input: z.object({ receipt_id: id, so_sem_vinculo: z.boolean().default(false) }),
  async run({ receipt_id, so_sem_vinculo }, ctx) {
    const { data: rc } = await ctx.supabase.schema("purch").from("receipts").select("id, number, status").eq("id", receipt_id).maybeSingle();
    if (!rc) fail("Nota não encontrada");
    let q = ctx.supabase.schema("purch").from("receipt_items").select("id, n_item, supplier_cprod, cean, description, ncm, unit, qty_nfe, unit_cost_nfe, variant_id, match_status, match_confidence")
      .eq("receipt_id", receipt_id).order("n_item");
    if (so_sem_vinculo) q = q.is("variant_id", null);
    const { data: items, error } = await q;
    dbError(error);
    const ids = [...new Set((items ?? []).map((i) => i.variant_id).filter(Boolean))] as string[];
    const label = new Map<string, string>();
    if (ids.length) {
      const { data: vs } = await ctx.supabase.schema("catalog").from("variants").select("id, sku, size, colors(name), products!inner(name, reference_code)").in("id", ids);
      for (const v of vs ?? []) {
        const p = v.products as unknown as { name: string; reference_code: string };
        label.set(v.id, `${p.reference_code} ${p.name} · ${(v.colors as unknown as { name: string } | null)?.name ?? "—"} · ${v.size}`);
      }
    }
    return {
      nota: rc!.number, situacao: STATUS[rc!.status] ?? rc!.status,
      itens: (items ?? []).map((i) => ({
        item_id: i.id, n: i.n_item, descricao: i.description, codigo_fornecedor: i.supplier_cprod, ean: i.cean, ncm: i.ncm, qtd: Number(i.qty_nfe), custo_unit: Number(i.unit_cost_nfe),
        ligado_a: i.variant_id ? { variant_id: i.variant_id, peca: label.get(i.variant_id) ?? null, como: i.match_status === "SUGGESTED" ? "sugestão automática (confirme)" : "ligado" } : null,
      })),
    };
  },
});

const novoItem = z.object({
  item_id: id,
  variant_id: id.optional().describe("peça que já existe no catálogo (de buscar_produto)"),
  product_id: id.optional().describe("produto que já existe: o item vira uma cor/tamanho dele"),
  referencia: z.string().trim().min(1).max(40).optional().describe("referência (modelo) do produto; a mesma para todas as cores e tamanhos do modelo"),
  nome: z.string().trim().min(2).max(120).optional().describe("nome do produto SEM cor e SEM tamanho (só para produto novo)"),
  genero: z.enum(["FEM", "MASC", "UNISSEX"]).optional(),
  categoria: z.string().trim().max(60).optional(),
  cor: z.string().trim().min(1).max(40).optional(),
  tamanho: z.string().trim().min(1).max(10).optional(),
  preco: z.number().positive().max(100000).optional().describe("preço de venda (só entra se o produto ainda não tem)"),
});

const proporVinculoNota = tool({
  name: "propor_vinculo_nota",
  description: "Prepara o cartão que liga os itens de uma nota em recebimento ao catálogo. Para cada item: variant_id (peça existente) OU cor + tamanho de um produto (product_id, ou referência já cadastrada, ou referência nova + nome para produto novo). Cores e tamanhos do mesmo modelo usam a MESMA referência e o MESMO nome (sem cor/tamanho no nome): viram variações de um produto só, nunca um produto por item. Não lança no estoque.",
  perms: ["purch.write"],
  status: "Montando o vínculo da nota…",
  input: z.object({ receipt_id: id, itens: z.array(novoItem).min(1).max(200) }),
  async run({ receipt_id, itens }, ctx) {
    const { data: rc } = await ctx.supabase.schema("purch").from("receipts").select("id, number, status").eq("id", receipt_id).maybeSingle();
    if (!rc) fail("Nota não encontrada");
    if (rc!.status === "POSTED") fail("Esta nota já foi lançada no estoque.");
    const { data: rows } = await ctx.supabase.schema("purch").from("receipt_items").select("id, n_item, description, qty_nfe").eq("receipt_id", receipt_id);
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    const warnings: string[] = [];
    const args: Record<string, unknown>[] = [];
    const refs = [...new Set(itens.map((i) => i.referencia?.toUpperCase()).filter(Boolean))] as string[];
    const productIds = [...new Set(itens.map((i) => i.product_id).filter(Boolean))] as string[];
    const variantIds = [...new Set(itens.map((i) => i.variant_id).filter(Boolean))] as string[];
    const [{ data: existing }, { data: prods }, { data: vars }] = await Promise.all([
      refs.length ? ctx.supabase.schema("catalog").from("products").select("id, name, reference_code").in("reference_code", refs) : Promise.resolve({ data: [] as { id: string; name: string; reference_code: string }[] }),
      productIds.length ? ctx.supabase.schema("catalog").from("products").select("id, name, reference_code").in("id", productIds) : Promise.resolve({ data: [] as { id: string; name: string; reference_code: string }[] }),
      variantIds.length ? ctx.supabase.schema("catalog").from("variants").select("id, sku, size, products!inner(name, reference_code)").in("id", variantIds) : Promise.resolve({ data: [] as never[] }),
    ]);
    const existingRef = new Map((existing ?? []).map((p) => [p.reference_code, p]));
    const prodById = new Map((prods ?? []).map((p) => [p.id, p]));
    const varById = new Map((vars ?? []).map((v: { id: string; sku: string; size: string; products: unknown }) => [v.id, v]));

    const linked: string[] = [];
    const variations = new Map<string, string[]>();                  // produto existente → cores/tamanhos novos
    const created = new Map<string, { nome: string; pecas: string[] }>();  // referência nova → produto novo
    for (const i of itens) {
      const row = byId.get(i.item_id);
      if (!row) fail(`O item ${i.item_id} não é desta nota.`);
      if (i.variant_id) {
        const v = varById.get(i.variant_id) as { sku: string; size: string; products: { name: string } } | undefined;
        if (!v) fail(`Peça ${i.variant_id} não encontrada no catálogo.`);
        linked.push(`${row!.n_item}. ${row!.description} → ${v!.products.name} ${v!.size} (${v!.sku})`);
        args.push({ item_id: i.item_id, variant_id: i.variant_id });
        continue;
      }
      if (!i.cor || !i.tamanho) fail(`Item ${row!.n_item} (${row!.description}): informe cor e tamanho, ou a peça existente (variant_id).`);
      const cor = i.cor!, tamanho = i.tamanho!.toUpperCase();
      const ref = i.referencia?.toUpperCase();
      const prod = i.product_id ? prodById.get(i.product_id) : ref ? existingRef.get(ref) : undefined;
      if (i.product_id && !prod) fail(`Produto ${i.product_id} não encontrado.`);
      const piece = `${cor} ${tamanho}`;
      if (prod) {
        const key = `${prod.reference_code} ${prod.name}`;
        variations.set(key, [...(variations.get(key) ?? []), piece]);
        args.push({ item_id: i.item_id, product_id: prod.id, color: cor, size: tamanho, price: i.preco });
      } else {
        if (!ref || !i.nome) fail(`Item ${row!.n_item} (${row!.description}): produto novo precisa de referência e nome.`);
        const nome = i.nome!.trim();
        const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|\\s)(${esc(tamanho)}|${esc(cor)})(\\s|$)`, "i").test(nome)) warnings.push(`O nome "${nome}" parece conter a cor ou o tamanho: o nome do produto é o do modelo (cor e tamanho viram variações).`);
        const c = created.get(ref!) ?? { nome, pecas: [] };
        if (c.nome !== nome) warnings.push(`A referência ${ref} veio com nomes diferentes ("${c.nome}" e "${nome}"): fica um produto só, com o primeiro nome.`);
        c.pecas.push(piece);
        created.set(ref!, c);
        args.push({ item_id: i.item_id, reference: ref, name: c.nome, gender: i.genero ?? "FEM", category: i.categoria, color: cor, size: tamanho, price: i.preco });
      }
    }
    // dois produtos novos com o mesmo nome costumam ser o mesmo modelo em cores diferentes (subproduto virando produto)
    const byName = new Map<string, string[]>();
    for (const [ref, c] of created) byName.set(c.nome.toLowerCase(), [...(byName.get(c.nome.toLowerCase()) ?? []), ref]);
    for (const [nome, rs] of byName) if (rs.length > 1) warnings.push(`${rs.length} produtos novos com o mesmo nome "${nome}" (${rs.join(", ")}): se forem o mesmo modelo, use uma referência só.`);
    const missing = (rows ?? []).filter((r) => !itens.some((i) => i.item_id === r.id)).length;
    if (missing) warnings.push(`${missing} item(ns) da nota ficam sem mudança neste cartão.`);

    const lines: ActionLine[] = [
      { label: "Nota", value: `NF-e ${rc!.number} · ${itens.length} item(ns)` },
      ...[...created].map(([ref, c]) => ({ label: `Produto novo ${ref} — ${c.nome}`, value: `${c.pecas.length} variação(ões): ${c.pecas.join(", ")}` })),
      ...[...variations].map(([p, ps]) => ({ label: `Em ${p}`, value: `${ps.length} cor/tamanho: ${ps.join(", ")}` })),
      ...(linked.length ? [{ label: "Ligar a peças existentes", value: `${linked.length}` }] : []),
      ...linked.slice(0, 8).map((l) => ({ label: "", value: l })),
      { label: "Depois", value: "conferir, contar e lançar no estoque na tela do recebimento" },
    ];
    const r = await propose(ctx, "vincular_nota", { receipt_id, itens: args }, { produtos_novos: created.size, variacoes: [...variations.values()].flat().length, ligar: linked.length },
      { title: `Vincular NF-e ${rc!.number} ao catálogo`, lines, warnings });
    return { ...r, produtos_novos: [...created].map(([ref, c]) => ({ referencia: ref, nome: c.nome, variacoes: c.pecas.length })), variacoes_em_existentes: [...variations.values()].flat().length, ligar: linked.length };
  },
});

export const COMPRAS_TOOLS: ToolDef[] = [notasPendentes, itensNota, proporVinculoNota];
