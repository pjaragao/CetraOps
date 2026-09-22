"""
CetraOps / SIÉ Joy OS - Supabase Integration Client
Permite sincronização bidirecional, consultas PostgREST e persistência híbrida (Supabase + JSON fallback).
Zero dependências externas obrigatórias (usa urllib.request nativo), com suporte opcional a supabase-py.
"""

import os
import json
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

# Carregar variáveis de ambiente de .env se existir
def _load_dotenv():
    env_paths = [
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"),
        os.path.abspath(".env")
    ]
    for p in env_paths:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("\"'")
                            if k not in os.environ:
                                os.environ[k] = v
            except Exception:
                pass

_load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY") 
    or os.environ.get("SUPABASE_ANON_KEY") 
    or os.environ.get("SUPABASE_KEY", "")
)

def is_configured() -> bool:
    """Verifica se as variáveis essenciais de conexão com Supabase foram fornecidas"""
    return bool(SUPABASE_URL and SUPABASE_KEY and "seu-projeto" not in SUPABASE_URL)

def get_status() -> dict:
    """Retorna o status atual da integração Supabase"""
    configured = is_configured()
    return {
        "configured": configured,
        "supabaseUrl": SUPABASE_URL if configured else None,
        "authMode": "SERVICE_ROLE" if os.environ.get("SUPABASE_SERVICE_ROLE_KEY") else ("ANON" if os.environ.get("SUPABASE_ANON_KEY") else "CUSTOM_KEY"),
        "timestamp": datetime.now().isoformat()
    }

def _make_request(endpoint: str, method: str = "GET", data=None, extra_headers=None):
    """Executa requisição HTTP nativa à API REST do Supabase (PostgREST)"""
    if not is_configured():
        raise ValueError("Supabase não está configurado. Defina SUPABASE_URL e SUPABASE_KEY.")

    url = f"{SUPABASE_URL}/rest/v1/{endpoint.lstrip('/')}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    if extra_headers:
        headers.update(extra_headers)

    body_bytes = None
    if data is not None:
        body_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode("utf-8")
            return json.loads(res_body) if res_body else None
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8")
        raise RuntimeError(f"Erro Supabase HTTP {e.code}: {err_msg}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Erro de conexão com Supabase: {e.reason}")

def test_connection() -> dict:
    """Testa a conectividade com o Supabase executando um ping na API REST"""
    if not is_configured():
        return {
            "success": False,
            "message": "Supabase não configurado. Defina SUPABASE_URL e SUPABASE_KEY em seu ambiente ou arquivo .env."
        }
    try:
        start = datetime.now()
        # Consulta tabela crm_leads limit 1
        _make_request("crm_leads?select=id&limit=1")
        latency = round((datetime.now() - start).total_seconds() * 1000, 2)
        return {
            "success": True,
            "message": f"Conexão com Supabase estabelecida com sucesso! ({latency}ms)",
            "url": SUPABASE_URL,
            "latencyMs": latency
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Falha na conexão com Supabase: {str(e)}",
            "url": SUPABASE_URL
        }

def fetch_table(table_name: str, select: str = "*", limit: int = 1000):
    """Busca registros de uma tabela no Supabase"""
    endpoint = f"{table_name}?select={urllib.parse.quote(select)}&limit={limit}"
    return _make_request(endpoint, method="GET")

def upsert_records(table_name: str, records, on_conflict: str = "id"):
    """Insere ou atualiza registros no Supabase via PostgREST (upsert)"""
    if not isinstance(records, list):
        records = [records]
    if not records:
        return []
    
    headers = {
        "Prefer": f"resolution=merge-duplicates,return=representation"
    }
    return _make_request(table_name, method="POST", data=records, extra_headers=headers)

# Mapeamento entre arquivos JSON e tabelas do Supabase
TABLE_MAP = {
    "crm_leads.json": ("crm_leads", lambda d: d if isinstance(d, list) else []),
    "crm_qualification_rules.json": ("crm_qualification_rules", lambda d: [{"id": "default", **d}]),
    "scraping_targets.json": ("scraping_targets", lambda d: d.get("targets", []) if isinstance(d, dict) else []),
    "stone_catalog.json": ("stone_catalog", lambda d: [
        {
            "id": item.get("id"),
            "stone_sku": item.get("stoneSku"),
            "name": item.get("name"),
            "category": item.get("category"),
            "color": item.get("color"),
            "price": item.get("price"),
            "cost": item.get("cost"),
            "current_stock": item.get("currentStock", {}),
            "min_stock_target": item.get("minStockTarget", {}),
            "sales_velocity_weekly": item.get("salesVelocityWeekly", 0),
            "lead_time_days": item.get("leadTimeDays", 15)
        } for item in (d if isinstance(d, list) else [])
    ]),
    "accounts_payable.json": ("accounts_payable", lambda d: [
        {
            "id": p.get("id"),
            "cnpj_id": p.get("cnpjId"),
            "store_id": p.get("storeId"),
            "supplier_name": p.get("supplierName"),
            "category": p.get("category"),
            "description": p.get("description"),
            "amount": p.get("amount"),
            "due_date": p.get("dueDate"),
            "status": p.get("status"),
            "barcode": p.get("barcode"),
            "payment_method": p.get("paymentMethod")
        } for p in (d.get("payables", []) if isinstance(d, dict) else [])
    ]),
    "accounts_receivable.json": ("accounts_receivable", lambda d: [
        {
            "id": r.get("id"),
            "cnpj_id": r.get("cnpjId"),
            "store_id": r.get("storeId"),
            "description": r.get("description"),
            "client_name": r.get("clientName"),
            "gross_amount": r.get("grossAmount"),
            "net_amount": r.get("netAmount"),
            "fee_amount": r.get("feeAmount", 0),
            "payment_method": r.get("paymentMethod"),
            "due_date": r.get("dueDate"),
            "status": r.get("status")
        } for r in (d.get("receivables", []) if isinstance(d, dict) else [])
    ]),
    "bank_reconciliation.json": ("bank_reconciliation", lambda d: [
        {
            "id": b.get("id"),
            "date": b.get("date"),
            "description": b.get("description"),
            "amount": b.get("amount"),
            "type": b.get("type"),
            "status": b.get("status"),
            "stone_reference": b.get("stoneReference"),
            "notes": b.get("notes")
        } for b in (d.get("entries", []) if isinstance(d, dict) else [])
    ]),
    "drops_campaigns.json": ("drops_campaigns", lambda d: [
        {
            "id": c.get("id"),
            "name": c.get("name"),
            "launch_date": c.get("launchDate"),
            "theme": c.get("theme"),
            "status": c.get("status"),
            "budget": c.get("budget", 0),
            "revenue_target": c.get("revenueTarget", 0),
            "details": c.get("details", {})
        } for c in (d.get("campaigns", []) if isinstance(d, dict) else [])
    ])
}

def sync_all_local_to_supabase(data_dir: str) -> dict:
    """Lê os arquivos JSON locais e envia todos os dados para o Supabase"""
    if not is_configured():
        return {"success": False, "error": "Supabase não configurado"}

    results = {}
    for filename, (table_name, transformer) in TABLE_MAP.items():
        filepath = os.path.join(data_dir, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    raw_data = json.load(f)
                records = transformer(raw_data)
                if records:
                    res = upsert_records(table_name, records)
                    results[table_name] = {"status": "synced", "count": len(records)}
                else:
                    results[table_name] = {"status": "skipped", "count": 0}
            except Exception as e:
                results[table_name] = {"status": "error", "error": str(e)}

    return {"success": True, "results": results, "timestamp": datetime.now().isoformat()}
