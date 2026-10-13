"""Esquemas (JSON Schema) das ferramentas do agente, no formato de function calling. O mesmo contrato é exposto pelo servidor MCP."""
from __future__ import annotations

from typing import Any


def _fn(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}}}


UUID = {"type": "string", "description": "UUID"}
ITEMS = {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "object", "properties": {"variant_id": UUID, "qty": {"type": "number", "minimum": 1, "maximum": 5}}, "required": ["variant_id"]}}

TOOLS: list[dict[str, Any]] = [
    _fn("search_catalog", "Busca produtos por nome, cor, categoria, linha, tecido ou detalhe (ex.: 'short com bolso'). Devolve preço, tamanhos em estoque, foto, "
        "composição, aviso de modelagem e availability: IN_STOCK (tem na loja), BACKORDER (sem estoque, mas pode ser encomendada) ou OUT_OF_STOCK.",
        {"query": {"type": "string"}, "category": {"type": "string"}, "color": {"type": "string"}, "price_max": {"type": "number"}, "in_stock_only": {"type": "boolean"}}, ["query"]),
    _fn("check_stock_by_size", "Estoque disponível por tamanho e cor de um produto/variante/SKU; backorder_ok = sem estoque, mas pode ser encomendado.",
        {"product_id": UUID, "variant_id": UUID, "sku": {"type": "string"}, "color": {"type": "string"}}),
    _fn("get_product_details", "Detalhes de um produto: descrição, composição (tecido), cuidados, aviso de modelagem, guia de tamanhos (medidas) e fotos por cor.",
        {"product_id": UUID}, ["product_id"]),
    _fn("get_store_info", "Endereço e horário da loja (próximos 7 dias, feriados e exceções) e se está aberta agora. O que não vier não está cadastrado: não invente.", {}),
    _fn("get_customer_360", "Resumo seguro da cliente: nome, tamanhos, últimas compras, vale-troca.", {}),
    _fn("get_order_status", "Situação dos pedidos da cliente (últimos 3 ou por número).", {"number": {"type": "string"}}),
    _fn("get_policies", "Políticas da loja (troca, pagamento, entrega). Sem tema, lista os temas.", {"topic": {"type": "string"}}),
    _fn("search_knowledge", "Busca na base de conhecimento da loja (cuidado com as peças, marca, eventos, dúvidas frequentes). Devolve trechos publicados pela equipe; se nada voltar, não invente.", {"query": {"type": "string"}}, ["query"]),
    _fn("apply_coupon", "Valida um cupom informado pela cliente e calcula o desconto. A IA não cria desconto.", {"code": {"type": "string"}, "subtotal": {"type": "number"}}, ["code", "subtotal"]),
    _fn("create_reservation", "Retém uma peça por até 48 h (máx. 3 itens por cliente).", {"variant_id": UUID, "qty": {"type": "number"}, "hold_hours": {"type": "integer"}}, ["variant_id"]),
    _fn("schedule_locker", "Pede à vendedora para preparar o Armário VIP (1 a 3 peças).", {"items": ITEMS, "when": {"type": "string"}, "notes": {"type": "string"}}, ["items"]),
    _fn("create_order_draft", "Monta o pedido em rascunho (totais calculados no banco). Confirme itens e total com a cliente.",
        {"items": ITEMS, "coupon_code": {"type": "string"}, "fulfillment_type": {"type": "string", "enum": ["MOTOBOY", "CARRIER", "STORE_PICKUP", "LOCKER_PICKUP"]}, "shipping_total": {"type": "number"}}, ["items"]),
    _fn("confirm_order_draft", "Confirma o rascunho DEPOIS de uma mensagem da cliente aceitando itens e total.", {"order_id": UUID, "customer_message_id": UUID}, ["order_id", "customer_message_id"]),
    _fn("create_payment_link", "Gera o link de pagamento de um pedido já confirmado pela cliente.", {"order_id": UUID, "max_installments": {"type": "integer"}}, ["order_id"]),
    _fn("register_consent", "Registra o consentimento (ou recusa) de marketing dado pela cliente na conversa.",
        {"purpose": {"type": "string", "enum": ["MARKETING_WHATSAPP", "MARKETING_EMAIL", "MARKETING_IG", "AI_PROFILING"]}, "granted": {"type": "boolean"}, "message_id": UUID}, ["purpose", "granted"]),
    _fn("update_customer_profile", "Atualiza tamanhos, preferências, cidade ou aniversário informados pela cliente.",
        {"sizes": {"type": "object"}, "preferences": {"type": "object"}, "birth_date": {"type": "string"}, "city": {"type": "string"}}),
    _fn("list_upcoming_events", "Eventos próximos para os quais ESTA cliente foi convidada (data, local, vagas e a resposta dela). Sem convite, não ofereça eventos.", {}),
    _fn("rsvp_event", "Registra a resposta da cliente a um convite (CONFIRMED ou DECLINED) depois de ela dizer que vai ou não vai. Respeita a capacidade: lotado vira lista de espera.",
        {"event_id": UUID, "status": {"type": "string", "enum": ["CONFIRMED", "DECLINED"]}, "plus_ones": {"type": "integer", "minimum": 0, "maximum": 5}}, ["event_id", "status"]),
    _fn("register_interest", "Registra o 'avise-me': a cliente quer um produto num tamanho sem estoque. Quando chegar, ela é avisada (não prometa data).",
        {"product_id": UUID, "size": {"type": "string"}, "note": {"type": "string"}}, ["product_id", "size"]),
    _fn("remember_customer_fact", "Guarda um fato útil e não sensível dito pela cliente (ex.: faz pilates às terças).", {"fact": {"type": "string"}, "category": {"type": "string"}, "message_id": UUID}, ["fact"]),
    _fn("request_handoff", "Transfere para uma pessoa da equipe.",
        {"reason_code": {"type": "string", "enum": ["COMPLAINT", "PRICE_NEGOTIATION", "DEFECT", "B2B", "PAYMENT_PROBLEM", "PRESS_PARTNERSHIP", "HIGH_VALUE", "BACKORDER", "OUT_OF_SCOPE", "OTHER"]},
         "summary": {"type": "string"}, "urgency": {"type": "string", "enum": ["NORMAL", "HIGH"]}}, ["reason_code", "summary"]),
    _fn("propose_reply", "RESPOSTA FINAL: 1 a 3 mensagens curtas para a cliente. Sempre termine chamando esta ferramenta.",
        {"messages": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string", "maxLength": 600}},
         "intent": {"type": "string"}, "stage": {"type": "string"}, "confidence": {"type": "number", "minimum": 0, "maximum": 1},
         "needs_human": {"type": "boolean"}, "reason": {"type": "string"}}, ["messages", "confidence"]),
]

BY_NAME = {t["function"]["name"]: t for t in TOOLS}


def schemas_for(caps: list[str]) -> list[dict[str, Any]]:
    return [BY_NAME[c] for c in caps if c in BY_NAME]
