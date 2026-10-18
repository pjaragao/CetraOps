/** Catálogo do PDV (tela web e app da maquininha). */
export interface PosVariant { id: string; sku: string; size: string; gtin: string | null; price: number; available: number }
/** backorder: produto liberado para encomenda (o tamanho sem estoque entra no carrinho como encomenda). */
export interface PosProduct { key: string; name: string; reference: string; gender: string; color: string; backorder: boolean; variants: PosVariant[] }
