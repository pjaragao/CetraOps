"""Testes puros (sem banco): normalizadores, pré-regras, validador, token de contexto e adapters HTTP."""
from __future__ import annotations

import httpx
import jwt
import pytest
import respx

from centralops_agent_contract import CONCIERGE_CAPS, COPILOT_CAPS, sign_ctx, verify_ctx
from centralops_worker.adapters.brasilnfe import BrasilNfeClient
from centralops_worker.adapters.brasilnfe import normalize_received as brasilnfe_normalize_received
from centralops_worker.adapters.errors import PermanentError, TransientError
from centralops_worker.adapters.focus import FocusClient
from centralops_worker.adapters.meta import MetaClient
from centralops_worker.adapters.notaas import NotaasClient, _to_notaas_payload
from centralops_worker.adapters.stone import StoneClient
from centralops_worker.adapters.telegram import TelegramClient
from centralops_worker.ai import guardrails, rules
from centralops_worker.ai.agent import AgentInput, AgentOutput, FallbackAgent, HermesAgent, OpenRouterAgent
from centralops_worker.normalizer import normalize
from centralops_worker.runner import backoff_s

WA = {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": {
    "messaging_product": "whatsapp", "metadata": {"phone_number_id": "PNID1"},
    "contacts": [{"profile": {"name": "Fernanda"}, "wa_id": "5548999998888"}],
    "messages": [
        {"from": "5548999998888", "id": "wamid.1", "timestamp": "1727700000", "type": "text", "text": {"body": "Oi! Tem legging preta?"},
         "referral": {"source_url": "https://fb.me/ad", "source_type": "ad", "source_id": "123", "ctwa_clid": "AbC"}},
        {"from": "5548999998888", "id": "wamid.2", "timestamp": "1727700001", "type": "image", "image": {"id": "MEDIA1", "mime_type": "image/jpeg", "caption": "essa aqui"}},
        {"from": "5548999998888", "id": "wamid.3", "timestamp": "1727700002", "type": "audio", "audio": {"id": "MEDIA2", "voice": True}},
        {"from": "5548999998888", "id": "wamid.4", "timestamp": "1727700003", "type": "interactive", "interactive": {"button_reply": {"id": "b1", "title": "Quero reservar"}}},
    ],
    "statuses": [{"id": "wamid.OUT", "status": "failed", "timestamp": "1727700004", "recipient_id": "5548999998888", "errors": [{"code": 131047, "title": "Re-engagement message"}]},
                 {"id": "wamid.OUT2", "status": "read", "timestamp": "1727700005"}]}}]}]}


def test_whatsapp_messages_and_statuses() -> None:
    ev = normalize("META_WA", WA)
    kinds = [(e["kind"], e.get("type"), e.get("body")) for e in ev]
    assert kinds[0] == ("MESSAGE", "TEXT", "Oi! Tem legging preta?")
    assert ev[0]["referral"]["ctwa_clid"] == "AbC" and ev[0]["display_name"] == "Fernanda" and ev[0]["provider_account_id"] == "PNID1"
    assert ev[1]["type"] == "IMAGE" and ev[1]["body"] == "essa aqui" and ev[1]["payload"]["media"]["id"] == "MEDIA1"
    assert ev[2]["type"] == "AUDIO" and ev[2]["body"] == "[áudio]"
    assert ev[3]["body"] == "Quero reservar" and ev[3]["payload"]["reply_id"] == "b1"
    assert ev[4] == {"kind": "STATUS", "channel": "WHATSAPP", "provider_account_id": "PNID1", "provider_message_id": "wamid.OUT", "status": "FAILED",
                     "error": "131047: Re-engagement message", "occurred_at": ev[4]["occurred_at"]}
    assert ev[5]["status"] == "READ"


def test_whatsapp_coexistence_echo_uses_recipient_as_customer() -> None:
    payload = {"entry": [{"changes": [{"field": "smb_message_echoes", "value": {"metadata": {"phone_number_id": "PNID1"}, "message_echoes": [
        {"from": "5548911112222", "to": "5548999998888", "id": "wamid.E", "timestamp": "1727700000", "type": "text", "text": {"body": "Oi, é a Luisa!"}}]}}]}]}
    (e,) = normalize("META_WA", payload)
    assert e["kind"] == "ECHO" and e["external_id"] == "5548999998888" and e["body"] == "Oi, é a Luisa!"


def test_instagram_dm_story_reply_echo_comment() -> None:
    payload = {"object": "instagram", "entry": [{"id": "IGBIZ", "time": 1727700000, "messaging": [
        {"sender": {"id": "IGSID1"}, "recipient": {"id": "IGBIZ"}, "timestamp": 1727700000000, "message": {"mid": "m1", "text": "oi!"}},
        {"sender": {"id": "IGSID1"}, "recipient": {"id": "IGBIZ"}, "timestamp": 1727700001000, "message": {"mid": "m2", "text": "amei", "reply_to": {"story": {"id": "S1", "url": "u"}}}},
        {"sender": {"id": "IGBIZ"}, "recipient": {"id": "IGSID1"}, "timestamp": 1727700002000, "message": {"mid": "m3", "text": "resposta pelo app", "is_echo": True}},
        {"sender": {"id": "IGSID1"}, "recipient": {"id": "IGBIZ"}, "timestamp": 1727700003000, "read": {"mid": "m3"}},
        {"sender": {"id": "IGSID2"}, "recipient": {"id": "IGBIZ"}, "timestamp": 1727700004000, "message": {"mid": "m4", "attachments": [{"type": "story_mention", "payload": {"url": "x"}}]}},
    ], "changes": [{"field": "comments", "value": {"id": "C1", "text": "quero!", "from": {"id": "IGSID9", "username": "ana"}, "media": {"id": "MEDIA9"}}}]}]}
    ev = normalize("META_IG", payload)
    assert [e["type"] for e in ev if e["kind"] != "STATUS"] == ["TEXT", "STORY_REPLY", "TEXT", "STORY_MENTION", "COMMENT"]
    assert ev[2]["kind"] == "ECHO" and ev[2]["external_id"] == "IGSID1"
    assert ev[3] == {"kind": "STATUS", "channel": "INSTAGRAM", "provider_account_id": "IGBIZ", "provider_message_id": "m3", "status": "READ", "occurred_at": ev[3]["occurred_at"]}
    assert ev[4]["body"] == "[menção no story]"
    assert ev[5]["external_id"] == "IGSID9" and ev[5]["handle"] == "ana" and ev[5]["provider_message_id"] == "comment:C1"


def test_telegram_start_deeplink_and_group_ignored() -> None:
    up = {"update_id": 1, "_bot_id": "987", "message": {"message_id": 5, "date": 1727700000, "chat": {"id": 123, "type": "private"},
                                                          "from": {"id": 123, "is_bot": False, "first_name": "Ana", "username": "ana"}, "text": "/start tok_abc"}}
    (e,) = normalize("TELEGRAM", up)
    assert e["external_id"] == "123" and e["provider_message_id"] == "123:5" and e["payload"]["start_param"] == "tok_abc" and e["display_name"] == "Ana"
    up["message"]["chat"]["type"] = "group"
    assert normalize("TELEGRAM", up) == []
    del up["_bot_id"]
    up["message"]["chat"]["type"] = "private"
    with pytest.raises(ValueError):
        normalize("TELEGRAM", up)


def test_unknown_provider() -> None:
    with pytest.raises(ValueError):
        normalize("NOPE", {})


@pytest.mark.parametrize("text,rule", [
    ("PARAR", "OPT_OUT"), ("não quero mais receber mensagens", "OPT_OUT"), ("sair", "OPT_OUT"),
    ("quero falar com a Luisa", "HUMAN_REQUEST"), ("tem algum atendente aí?", "HUMAN_REQUEST"),
    ("vou reclamar no Procon", "ESCALATE"), ("isso foi golpe", "ESCALATE"), ("vou fazer chargeback", "ESCALATE"),
    ("tem legging preta no M?", None), ("vou sair para treinar e volto", None), ("", None),
])
def test_pre_rules(text: str, rule: str | None) -> None:
    hit = rules.match_pre_rule(text)
    assert (hit.rule if hit else None) == rule


def test_guardrails_grounded_and_ungrounded() -> None:
    search = guardrails.ToolResult("search_catalog", True, {"products": [{"name": "Legging", "price": 429.0, "sizes_in_stock": ["M"]}]})
    ok = guardrails.validate(["Temos a legging no M por R$ 429,00.", "Separo para você?"], [search])
    assert ok == []
    bad = guardrails.validate(["Fica R$ 399,00 pra você."], [search])
    assert [v.code for v in bad] == ["UNGROUNDED_PRICE"]
    installment = guardrails.validate(["Dá 3x de R$ 143,00 sem juros."], [search])
    assert installment == []                                            # 429 / 3 = 143
    assert [v.code for v in guardrails.validate(["Temos sim no M!"], [])] == ["UNGROUNDED_STOCK"]
    assert "DISCOUNT_NOT_ALLOWED" in [v.code for v in guardrails.validate(["Consigo um desconto de 10% pra você"], [search])]
    coupon = guardrails.ToolResult("apply_coupon", True, {"coupon": {"valid": True, "discount": 42.9}})
    assert guardrails.validate(["Com o cupom BEMVINDA10 ficam R$ 42,90 de desconto"], [search, coupon]) == []
    assert "PII" in [v.code for v in guardrails.validate(["Seu CPF 123.456.789-09 já está cadastrado"], [])]
    assert "HEALTH_CLAIM" in [v.code for v in guardrails.validate(["Essa legging trata dor lombar"], [])]
    assert [v.code for v in guardrails.validate(["a", "b", "c", "d"], [])] == ["FORMAT"]
    assert guardrails.validate(["x" * 601], []) != []


def test_ctx_token_roundtrip_and_tamper() -> None:
    tok = sign_ctx("s3-secret-with-at-least-32-bytes!!", org="o", conv="c", party="p", run="r", version=3, caps=COPILOT_CAPS, mode="AI_COPILOT")
    data = verify_ctx("s3-secret-with-at-least-32-bytes!!", tok)
    assert data["conv"] == "c" and data["version"] == 3 and "create_payment_link" not in data["caps"] and "propose_reply" in data["caps"]
    assert "create_payment_link" in CONCIERGE_CAPS
    with pytest.raises(jwt.InvalidTokenError):
        verify_ctx("another-secret-with-32-bytes-min!!", tok)
    expired = sign_ctx("s3-secret-with-at-least-32-bytes!!", org="o", conv="c", party="p", run="r", version=1, caps=[], now=1_000_000)
    with pytest.raises(jwt.ExpiredSignatureError):
        verify_ctx("s3-secret-with-at-least-32-bytes!!", expired)


def test_backoff_is_bounded() -> None:
    assert [backoff_s(n) for n in (1, 2, 3, 4, 5, 9)] == [5, 15, 45, 135, 300, 300]


@pytest.mark.asyncio
@respx.mock
async def test_meta_send_and_error_classification() -> None:
    async with httpx.AsyncClient() as http:
        meta = MetaClient(http, "https://graph.test/v21.0", "TOK")
        route = respx.post("https://graph.test/v21.0/PNID1/messages").mock(return_value=httpx.Response(200, json={"messages": [{"id": "wamid.OK"}]}))
        assert await meta.send_whatsapp_text("PNID1", "5548999998888", "oi") == "wamid.OK"
        assert route.calls[0].request.headers["authorization"] == "Bearer TOK"
        assert b'"to":"5548999998888"' in route.calls[0].request.content.replace(b" ", b"")
        respx.post("https://graph.test/v21.0/PNID1/messages").mock(return_value=httpx.Response(429, json={"error": {"code": 130429, "message": "rate"}}))
        with pytest.raises(TransientError):
            await meta.send_whatsapp_text("PNID1", "1", "x")
        respx.post("https://graph.test/v21.0/PNID1/messages").mock(return_value=httpx.Response(400, json={"error": {"code": 131047, "message": "window"}}))
        with pytest.raises(PermanentError) as ei:
            await meta.send_whatsapp_text("PNID1", "1", "x")
        assert ei.value.code == 131047
        respx.post("https://graph.test/v21.0/IG1/messages").mock(return_value=httpx.Response(200, json={"recipient_id": "R", "message_id": "mid.9"}))
        assert await meta.send_instagram_text("IG1", "R", "oi", human_agent=True) == "mid.9"


@pytest.mark.asyncio
@respx.mock
async def test_telegram_send() -> None:
    async with httpx.AsyncClient() as http:
        tg = TelegramClient(http, "https://tg.test", "BOT")
        respx.post("https://tg.test/botBOT/sendMessage").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 7}}))
        assert await tg.send_message("123", "oi") == "123:7"
        respx.post("https://tg.test/botBOT/sendMessage").mock(return_value=httpx.Response(429, json={"ok": False, "parameters": {"retry_after": 9}}))
        with pytest.raises(TransientError) as ei:
            await tg.send_message("123", "oi")
        assert ei.value.retry_after == 9
        respx.post("https://tg.test/botBOT/sendMessage").mock(return_value=httpx.Response(403, json={"ok": False, "error_code": 403, "description": "bot was blocked"}))
        with pytest.raises(PermanentError):
            await tg.send_message("123", "oi")


@pytest.mark.asyncio
@respx.mock
async def test_focus_results() -> None:
    async with httpx.AsyncClient() as http:
        focus = FocusClient(http, "https://focus.test", "TOK")
        respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(201, json={
            "status": "autorizado", "numero": "12", "serie": "1", "chave_nfe": "NFe42260912345678000195650010000000121000000121", "protocolo": "P1", "caminho_danfe": "/d.pdf"}))
        r = await focus.emit_nfce("ref1", {"x": 1})
        assert (r.status, r.number, r.series, r.access_key, r.protocol) == ("AUTHORIZED", 12, 1, "42260912345678000195650010000000121000000121", "P1")
        assert respx.calls.last.request.headers["authorization"].startswith("Basic ")
        respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(422, json={"codigo": "requisicao_invalida", "mensagem": "NCM inválido"}))
        assert (await focus.emit_nfce("ref2", {})).status == "REJECTED"
        respx.get("https://focus.test/v2/nfce/ref3").mock(return_value=httpx.Response(200, json={"status": "processando_autorizacao"}))
        assert (await focus.get("65", "ref3")).status == "PROCESSING"
        respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(503))
        with pytest.raises(TransientError):
            await focus.emit_nfce("ref4", {})
        respx.post("https://focus.test/v2/nfce").mock(return_value=httpx.Response(401, json={"codigo": "permissao_negada"}))
        with pytest.raises(PermanentError):
            await focus.emit_nfce("ref5", {})


@pytest.mark.asyncio
@respx.mock
async def test_brasilnfe_results() -> None:
    async with httpx.AsyncClient() as http:
        client = BrasilNfeClient(http, "https://api.brasilnfe.test", "TOKEN123", user_token="USERTOK456")

        # Emissão NFC-e com sucesso
        respx.post("https://api.brasilnfe.test/EnviarNotaFiscal").mock(return_value=httpx.Response(200, json={
            "Status": "autorizado", "Numero": 99, "Serie": 2, "Chave": "42260912345678000195650010000000991000000991",
            "Protocolo": "PROTO99", "UrlDanfe": "https://danfe.pdf", "UrlXml": "https://xml.xml"
        }))
        r = await client.emit_nfce("ref_nfce_1", {"items": []})
        assert (r.status, r.number, r.series, r.access_key, r.protocol, r.danfe_path, r.xml_path) == (
            "AUTHORIZED", 99, 2, "42260912345678000195650010000000991000000991", "PROTO99", "https://danfe.pdf", "https://xml.xml"
        )
        assert respx.calls.last.request.headers["Token"] == "TOKEN123"
        assert respx.calls.last.request.headers["UserToken"] == "USERTOK456"
        assert respx.calls.last.request.headers["Authorization"] == "Bearer TOKEN123"

        # Emissão NF-e modelo 55
        respx.post("https://api.brasilnfe.test/EnviarNotaFiscal").mock(return_value=httpx.Response(200, json={
            "status": "autorizado", "numero": 101, "serie": 1, "chave": "42260912345678000195550010000001011000000101"
        }))
        rnfe = await client.emit_nfe("ref_nfe_1", {"items": []})
        assert (rnfe.status, rnfe.number) == ("AUTHORIZED", 101)

        # Consulta nota (get) em processamento
        respx.post("https://api.brasilnfe.test/ConsultarNotaFiscal").mock(return_value=httpx.Response(200, json={
            "status": "processando_autorizacao"
        }))
        assert (await client.get("65", "ref_nfce_1")).status == "PROCESSING"

        # Cancelamento de nota
        respx.post("https://api.brasilnfe.test/CancelarNotaFiscal").mock(return_value=httpx.Response(200, json={
            "status": "cancelado", "protocolo": "PROTCANC1"
        }))
        rcanc = await client.cancel("65", "ref_nfce_1", "Cancelamento solicitado pelo cliente dentro do prazo")
        assert (rcanc.status, rcanc.protocol) == ("CANCELLED", "PROTCANC1")

        # Erro 422 rejeição de validação
        respx.post("https://api.brasilnfe.test/EnviarNotaFiscal").mock(return_value=httpx.Response(422, json={
            "codigo": "778", "mensagem": "NCM inexistente"
        }))
        r_rej = await client.emit_nfce("ref_fail", {})
        assert r_rej.status == "REJECTED" and r_rej.code == "778"

        # 503 transient error
        respx.post("https://api.brasilnfe.test/EnviarNotaFiscal").mock(return_value=httpx.Response(503))
        with pytest.raises(TransientError):
            await client.emit_nfce("ref_trans", {})

        # 401 permanent error (credencial inválida)
        respx.post("https://api.brasilnfe.test/EnviarNotaFiscal").mock(return_value=httpx.Response(401))
        with pytest.raises(PermanentError):
            await client.emit_nfce("ref_perm", {})


@pytest.mark.asyncio
@respx.mock
async def test_brasilnfe_dfe_and_mde() -> None:
    async with httpx.AsyncClient() as http:
        client = BrasilNfeClient(http, "https://api.brasilnfe.test", "TOKEN123")

        # Ping
        respx.post("https://api.brasilnfe.test/ConsultarStatusSefaz").mock(return_value=httpx.Response(200, json={"status": "107"}))
        p = await client.ping(uf="SP", tp_amb=1)
        assert p["status"] == "online" and p["http_status"] == 200

        # list_received com formato PascalCase da Brasil NFe
        respx.post("https://api.brasilnfe.test/ObterNotasFiscais").mock(return_value=httpx.Response(200, json={
            "Notas": [
                {
                    "Chave": "42260912345678000195550010000000011000000011",
                    "Nsu": "1005",
                    "DocumentoEmitente": "11222333000199",
                    "NomeEmitente": "FORNECEDOR TESTE LTDA",
                    "ValorTotal": 1250.75,
                    "DataEmissao": "2026-10-09T10:00:00-03:00",
                    "Manifestacao": "CONFIRMADA"
                }
            ]
        }))
        notes = await client.list_received("12345678000195", 0)
        assert len(notes) == 1
        assert notes[0]["access_key"] == "42260912345678000195550010000000011000000011"
        assert notes[0]["nsu"] == "1005"
        assert notes[0]["issuer_cnpj"] == "11222333000199"
        assert notes[0]["amount"] == 1250.75
        assert notes[0]["manifest_status"] == "CONFIRMADA"

        # Manifest
        respx.post("https://api.brasilnfe.test/ManifestarNotaFiscal").mock(return_value=httpx.Response(200, json={"status": "manifestado"}))
        await client.manifest("42260912345678000195550010000000011000000011", "CIENCIA")

        # Received XML (corpo direto)
        respx.post("https://api.brasilnfe.test/ObterArquivoNotaFiscal").mock(return_value=httpx.Response(200, text="<nfeProc>xml_content</nfeProc>"))
        xml = await client.received_xml("42260912345678000195550010000000011000000011")
        assert xml == "<nfeProc>xml_content</nfeProc>"

        # Received XML 404 (ainda indisponível)
        respx.post("https://api.brasilnfe.test/ObterArquivoNotaFiscal").mock(return_value=httpx.Response(404))
        assert await client.received_xml("42260912345678000195550010000000011000000011") is None

        # Teste unitário de normalização de chave inválida
        assert brasilnfe_normalize_received({"chave": "invalida"}) is None


@pytest.mark.asyncio
@respx.mock
async def test_stone_pos_client() -> None:
    async with httpx.AsyncClient() as http:
        stone = StoneClient(http, "sk_test_1234567890abcdef")

        # Ping
        respx.get("https://api.pagar.me/core/v5/orders").mock(return_value=httpx.Response(200, json={"data": []}))
        p = await stone.ping()
        assert p["status"] == "online" and p["http_status"] == 200
        assert respx.calls.last.request.headers["Authorization"].startswith("Basic ")

        # Criar pedido direto para maquininha POS
        respx.post("https://api.pagar.me/core/v5/orders").mock(return_value=httpx.Response(200, json={
            "id": "or_test123",
            "code": "VEN-1001",
            "status": "pending",
            "amount": 19900,
            "poi_payment_settings": {
                "visible": True,
                "devices_serial_number": ["ST-88492019"],
                "display_name": "Venda #VEN-1001"
            }
        }))
        res = await stone.create_pos_order(
            code="VEN-1001",
            amount_cents=19900,
            terminal_serial="ST-88492019",
            display_name="Venda #VEN-1001",
            method="credit",
            installments=3,
        )
        assert res["id"] == "or_test123"
        req_json = respx.calls.last.request.read().decode("utf-8")
        assert "ST-88492019" in req_json
        assert "credit" in req_json

        # Consultar status do pedido
        respx.get("https://api.pagar.me/core/v5/orders/or_test123").mock(return_value=httpx.Response(200, json={
            "id": "or_test123",
            "status": "paid",
            "charges": [
                {
                    "id": "ch_999",
                    "code": "NSU_STONE_456",
                    "status": "paid",
                    "paid_amount": 19900,
                    "metadata": {
                        "scheme_name": "Visa",
                        "authorization_code": "AUT789",
                        "terminal_serial_number": "ST-88492019"
                    }
                }
            ]
        }))
        order = await stone.get_order("or_test123")
        assert order["status"] == "paid"
        assert order["charges"][0]["code"] == "NSU_STONE_456"

        # Cancelar pedido na maquininha
        respx.delete("https://api.pagar.me/core/v5/orders/or_test123/closed").mock(return_value=httpx.Response(200, json={"status": "canceled"}))
        canc = await stone.cancel_pos_order("or_test123")
        assert canc["status"] == "canceled"

        # Erro 401 credencial recusada
        respx.get("https://api.pagar.me/core/v5/orders").mock(return_value=httpx.Response(401))
        with pytest.raises(PermanentError):
            await stone.ping()


class _Scripted:
    """Agente de mentira: devolve/levanta conforme o roteiro, e guarda quantas vezes foi chamado."""

    def __init__(self, *steps: object) -> None:
        self.steps, self.calls = list(steps), 0

    async def run(self, inp: object) -> AgentOutput:
        step = self.steps[min(self.calls, len(self.steps) - 1)]
        self.calls += 1
        if isinstance(step, Exception):
            raise step
        return step if isinstance(step, AgentOutput) else AgentOutput(model=str(step))


async def test_fallback_agent_uses_plan_b_and_opens_the_circuit() -> None:
    now = [1000.0]
    hermes = _Scripted(TransientError("503"), TransientError("503"), PermanentError("401"), AgentOutput(model="hermes"))
    plan_b = _Scripted("plano-b")
    agent = FallbackAgent(hermes, plan_b, threshold=3, cooldown_s=60, clock=lambda: now[0])  # type: ignore[arg-type]
    inp = AgentInput(run_id="r", ctx={}, ctx_token="t", system_stable="", system_volatile="", history=[], model="m")
    for _ in range(3):                                                        # 3 falhas seguidas: cada execução cai para o Plano B e o circuito abre
        assert (await agent.run(inp)).model == "plano-b"
    assert hermes.calls == 3 and agent.open
    assert (await agent.run(inp)).model == "plano-b" and hermes.calls == 3     # circuito aberto: nem tenta o Hermes
    now[0] += 61                                                               # passou o resfriamento: testa o Hermes de novo
    assert not agent.open
    assert (await agent.run(inp)).model == "hermes" and hermes.calls == 4 and plan_b.calls == 4
    assert not agent.open                                                      # sucesso zera a contagem


async def test_fallback_agent_half_open_failure_reopens_immediately() -> None:
    now = [0.0]
    hermes = _Scripted(TransientError("x"))
    agent = FallbackAgent(hermes, _Scripted("b"), threshold=2, cooldown_s=10, clock=lambda: now[0])  # type: ignore[arg-type]
    inp = AgentInput(run_id="r", ctx={}, ctx_token="t", system_stable="", system_volatile="", history=[], model="m")
    await agent.run(inp)
    await agent.run(inp)
    assert agent.open
    now[0] += 11
    await agent.run(inp)                                                       # meia-abertura falhou: abre de novo já na primeira falha
    assert agent.open and hermes.calls == 3


def test_build_agent_picks_the_right_implementation() -> None:
    from centralops_worker.config import Settings
    from centralops_worker.main import build_agent

    http, pool = httpx.AsyncClient(), object()
    assert build_agent(Settings(hermes_key="", openrouter_key=""), pool, http) is None  # type: ignore[arg-type]
    assert isinstance(build_agent(Settings(hermes_key="h", openrouter_key=""), pool, http), HermesAgent)  # type: ignore[arg-type]
    assert isinstance(build_agent(Settings(hermes_key="", openrouter_key="o"), pool, http), OpenRouterAgent)  # type: ignore[arg-type]
    assert isinstance(build_agent(Settings(hermes_key="h", openrouter_key="o"), pool, http), FallbackAgent)  # type: ignore[arg-type]


def test_whatsapp_template_webhooks_become_template_events() -> None:
    def change(field: str, value: dict[str, object]) -> dict[str, object]:
        return {"object": "whatsapp_business_account", "entry": [{"id": "WABA9", "changes": [{"field": field, "value": value}]}]}

    (st,) = normalize("META_WA", change("message_template_status_update", {"event": "rejected", "message_template_id": 123, "message_template_name": "pedido_pronto",
                                                                         "message_template_language": "pt_BR", "reason": "INVALID_FORMAT"}))
    assert st == {"kind": "TEMPLATE", "waba_id": "WABA9", "external_id": "123", "name": "pedido_pronto", "language": "pt_BR", "status": "REJECTED", "reason": "INVALID_FORMAT", "quality": None}
    (ok,) = normalize("META_WA", change("message_template_status_update", {"event": "APPROVED", "message_template_id": 123, "message_template_name": "x", "message_template_language": "pt_BR", "reason": "NONE"}))
    assert ok["status"] == "APPROVED" and ok["reason"] is None
    (q,) = normalize("META_WA", change("message_template_quality_update", {"new_quality_score": "yellow", "message_template_id": 123, "message_template_name": "x", "message_template_language": "pt_BR"}))
    assert q["status"] is None and q["quality"] == "YELLOW"
    assert normalize("META_WA", change("message_template_quality_update", {"message_template_id": 1})) == []          # sem situação nem qualidade: nada
    assert normalize("META_WA", change("account_update", {"event": "x"})) == []


# ---------- persona: rótulos e exemplos de estilo ----------
def test_persona_fewshot_mmr_prefers_relevant_but_diverse_examples() -> None:
    from centralops_worker.persona.fewshot import cosine, format_examples, mmr

    def cand(dist: float, vec: list[float], weight: float = 1.0) -> dict:
        return {"distance": dist, "embedding": vec, "weight": weight, "context": [{"role": "customer", "text": "tem M?"}], "reply": ["Tem sim!", "Qual cor?"]}

    a, b, c = cand(0.05, [1, 0, 0]), cand(0.06, [1, 0.01, 0]), cand(0.2, [0, 1, 0])
    picked = mmr([a, b, c], k=2, lam=0.5)
    assert picked[0] is a and picked[1] is c                      # o quase idêntico ao primeiro perde para um diferente
    assert cosine([1, 0], [0, 1]) == 0.0 and cosine([0, 0], [1, 1]) == 0.0
    text = format_examples(picked)
    assert text.startswith("EXEMPLOS DE ESTILO") and "Resposta: Tem sim! / Qual cor?" in text and format_examples([]) == ""


def test_persona_label_helpers_keep_only_known_values() -> None:
    from centralops_worker.persona import labels

    turns = [{"role": "customer", "text": "oi"}, {"role": "owner", "text": "oi!"}, {"role": "owner", "text": "tudo bem?"}, {"role": "customer", "text": "sim"}, {"role": "owner", "text": "ótimo"}]
    assert labels.owner_positions(turns) == [1, 4]               # só respostas a um turno da cliente
    assert labels.clean_label("inventada", labels.INTENTS) == "outro" and labels.clean_label("PRECO", labels.INTENTS) == "preco"
    assert labels.clean_topics(["Família", "familia", " Tamanho ", "a", "b"]) == ["família", "familia", "tamanho"]
    assert "NUNCA diz que é Luisa" in labels.TRANSPARENCY.format(name="Luisa") and "{PRECO}" in labels.TRANSPARENCY.format(name="Luisa")


def test_team_instruction_reaches_the_volatile_prompt_only_when_present() -> None:
    from centralops_worker.ai import prompts

    base = dict(ctx_token="t", mode="AI_COPILOT", channel="WHATSAPP", window_mode="FREE_FORM", party_first_name="Ana")
    assert "Instrução da equipe" not in prompts.system_volatile(**base)
    assert "confirme o endereço" in prompts.system_volatile(**base, instruction="confirme o endereço")


def test_amounts_written_in_knowledge_text_count_as_grounded() -> None:
    from centralops_worker.ai import guardrails

    kb = guardrails.ToolResult("search_knowledge", True, {"results": [{"title": "Frete", "text": "Frete grátis para compras acima de R$ 500,00 na cidade."}]})
    assert guardrails.validate(["O frete é grátis acima de R$ 500,00."], [kb]) == []
    assert [v.code for v in guardrails.validate(["O frete é grátis acima de R$ 300,00."], [kb])] == ["UNGROUNDED_PRICE"]


def test_notaas_payload_mapping() -> None:
    doc = {
        "natureza_operacao": "VENDA PDV",
        "presenca_comprador": 1,
        "cpf_destinatario": "123.456.789-00",
        "nome_destinatario": "Cliente Teste",
        "itens": [
            {
                "codigo": "SKU1",
                "descricao": "Camiseta Algodao",
                "ncm": "61091000",
                "cfop": "5102",
                "quantidade": 2,
                "valor_unitario": 50.0,
                "valor_total": 100.0,
                "unidade": "UN",
                "csosn": "102",
                "desconto": 10.0,
            }
        ],
        "formas_pagamento": [{"tipoPagamento": "01", "valor": 90.0}],
    }
    payload = _to_notaas_payload(65, "ref_123", doc)
    assert payload["modelo"] == 65
    assert payload["naturezaOperacao"] == "VENDA PDV"
    assert payload["presencaComprador"] == 1
    assert payload["dest"] == {"cpf": "12345678900", "nome": "Cliente Teste"}
    assert len(payload["items"]) == 1
    item = payload["items"][0]
    assert item["codigo"] == "SKU1"
    assert item["ncm"] == "61091000"
    assert item["valorTotal"] == 100.0
    assert item["desconto"] == 10.0
    assert payload["pagamentos"] == [{"tipoPagamento": "01", "valor": 90.0}]


@pytest.mark.asyncio
@respx.mock
async def test_notaas_results() -> None:
    async with httpx.AsyncClient() as http:
        client = NotaasClient(http, "https://platform.notaas.com.br/api/v1", "ntaas_test_key_123")

        # 1) Emissão 202 queued/processing
        respx.post("https://platform.notaas.com.br/api/v1/nfe/emitir").mock(
            return_value=httpx.Response(202, json={"invoiceId": "inv_abc_123", "status": "queued"})
        )
        r_emit = await client.emit_nfce("ref_1", {"items": []})
        assert r_emit.status == "PROCESSING"
        assert r_emit.provider_ref == "inv_abc_123"

        # 2) Emissão autorizada direta
        respx.post("https://platform.notaas.com.br/api/v1/nfe/emitir").mock(
            return_value=httpx.Response(200, json={
                "status": "issued",
                "invoiceId": "inv_abc_123",
                "numero": 45,
                "serie": 1,
                "chaveAcesso": "42260912345678000195650010000000451000000045",
                "protocolo": "PROT45",
                "pdfUrl": "https://danfe.pdf",
                "xmlUrl": "https://xml.xml",
            })
        )
        r_auth = await client.emit_nfce("ref_2", {"items": []})
        assert r_auth.status == "AUTHORIZED"
        assert r_auth.number == 45
        assert r_auth.access_key == "42260912345678000195650010000000451000000045"
        assert r_auth.protocol == "PROT45"
        assert r_auth.danfe_path == "https://danfe.pdf"

        # 3) Consulta status (get)
        respx.get("https://platform.notaas.com.br/api/v1/nfe/invoices/inv_abc_123/status").mock(
            return_value=httpx.Response(200, json={
                "status": "issued",
                "chaveAcesso": "42260912345678000195650010000000451000000045",
                "protocolo": "PROT45",
            })
        )
        r_get = await client.get("65", "inv_abc_123")
        assert r_get.status == "AUTHORIZED"
        assert r_get.access_key == "42260912345678000195650010000000451000000045"

        # 4) Cancelamento de nota
        respx.post("https://platform.notaas.com.br/api/v1/nfe/cancelar").mock(
            return_value=httpx.Response(200, json={"status": "cancelled", "motivo": "Cancelado com sucesso"})
        )
        r_canc = await client.cancel("65", "inv_abc_123", "Cancelamento solicitado pelo cliente na loja")
        assert r_canc.status == "CANCELLED"
        assert r_canc.provider_ref == "inv_abc_123"

        # 5) Ping teste de credencial
        respx.get("https://platform.notaas.com.br/api/v1/webhooks/endpoints").mock(
            return_value=httpx.Response(200, json={"endpoints": []})
        )
        ping_res = await client.ping()
        assert ping_res["status"] == "online" and ping_res["http_status"] == 200

        # 6) Erro 401 credencial recusada
        respx.get("https://platform.notaas.com.br/api/v1/webhooks/endpoints").mock(
            return_value=httpx.Response(401, json={"error": "Unauthorized"})
        )
        with pytest.raises(PermanentError):
            await client.ping()

        # 7) Erro 500 transitório
        respx.post("https://platform.notaas.com.br/api/v1/nfe/emitir").mock(
            return_value=httpx.Response(500)
        )
        with pytest.raises(TransientError):
            await client.emit_nfce("ref_err", {})

