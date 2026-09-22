"""
SIÉ Joy OS - Backend Server & Stone Webhook Gateway
Servidor HTTP nativo em Python (Zero dependências externas).
Rotas de API REST, Webhooks da Stone, Simulador de IA WhatsApp e arquivos estáticos.
"""
import os
import json
import mimetypes
import hashlib
import random
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime

PORT = int(os.environ.get("PORT", 3001))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

try:
    import supabase_client
except ImportError:
    try:
        from sistema_web import supabase_client
    except ImportError:
        supabase_client = None

def load_json(filename):
    filepath = os.path.join(DATA_DIR, filename)
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_json(filename, data):
    filepath = os.path.join(DATA_DIR, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def calculate_lead_score(lead, rules):
    """Calcula score de 1 a 5 baseado nas regras ativas de qualificação"""
    score = 1
    bio_lower = (lead.get("bio") or "").lower()
    city_lower = (lead.get("city") or "").lower()
    
    # Profissão high-ticket
    for kw in rules.get("highTicketKeywords", []):
        if kw.lower() in bio_lower:
            score += rules.get("scoringWeights", {}).get("professionMatch", 2)
            break
            
    # Esportes e lifestyle
    for kw in rules.get("sportsAndLifestyleKeywords", []):
        if kw.lower() in bio_lower:
            score += rules.get("scoringWeights", {}).get("sportsMatch", 2)
            break
            
    # Contato direto
    if lead.get("phone") or lead.get("email"):
        score += rules.get("scoringWeights", {}).get("hasPhoneOrEmail", 1)
        
    # Cidade alvo
    for tc in rules.get("targetCities", []):
        if tc.lower() in city_lower:
            score += rules.get("scoringWeights", {}).get("targetCityMatch", 1)
            break
            
    return min(max(score, 1), 5)

class SieJoyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/status":
            return self.send_json({
                "status": "online",
                "app": "SIÉ Joy OS | Stone Integrated Retail Engine",
                "serverTime": datetime.now().isoformat(),
                "joyLocation": "Rua Esteves Júnior, 567 - Centro Florianópolis",
                "inauguration": "Outubro/2026",
                "rent": 6000.0,
                "gracePeriod": "3 meses de carência (R$ 18.000 de economia)",
                "supabase": supabase_client.get_status() if supabase_client else {"configured": False}
            })

        elif path == "/api/supabase/status":
            if supabase_client:
                return self.send_json(supabase_client.get_status())
            return self.send_json({"configured": False, "error": "supabase_client não inicializado"})

        elif path == "/api/financial-targets":
            return self.send_json(load_json("financial_targets.json"))

        elif path == "/api/catalog":
            return self.send_json(load_json("stone_catalog.json"))

        elif path == "/api/sales":
            return self.send_json(load_json("mock_stone_sales.json"))

        elif path == "/api/drops":
            return self.send_json(load_json("drops_campaigns.json"))

        elif path == "/api/purchasing/recommendations":
            catalog = load_json("stone_catalog.json")
            recommendations = []
            for item in catalog:
                total_stock = sum(item["currentStock"].values())
                target_stock = sum(item["minStockTarget"].values())
                weekly_vel = item["salesVelocityWeekly"]
                daily_vel = weekly_vel / 7.0
                days_stock_remaining = round(total_stock / max(daily_vel, 0.1), 1)
                
                suggested_replenish = max(target_stock - total_stock, 0)
                urgency = "ALTA" if days_stock_remaining < 7 else ("MEDIA" if days_stock_remaining < 15 else "NORMAL")
                
                revenue_potential = item["price"] * weekly_vel
                abc_class = "A" if revenue_potential > 1800 else ("B" if revenue_potential > 900 else "C")
                
                recommendations.append({
                    "productId": item["id"],
                    "stoneSku": item["stoneSku"],
                    "name": item["name"],
                    "category": item["category"],
                    "color": item["color"],
                    "price": item["price"],
                    "cost": item["cost"],
                    "totalStock": total_stock,
                    "targetStock": target_stock,
                    "salesVelocityWeekly": weekly_vel,
                    "daysStockRemaining": days_stock_remaining,
                    "suggestedOrderQty": suggested_replenish,
                    "orderCostTotal": round(suggested_replenish * item["cost"], 2),
                    "urgency": urgency,
                    "abcClass": abc_class,
                    "leadTimeDays": item["leadTimeDays"],
                    "bySize": {
                        size: max(item["minStockTarget"].get(size, 0) - item["currentStock"].get(size, 0), 0)
                        for size in ["P", "M", "G", "GG"]
                    }
                })
            
            return self.send_json({
                "generatedAt": datetime.now().isoformat(),
                "recommendations": recommendations,
                "totalBudgetNeeded": round(sum(r["orderCostTotal"] for r in recommendations), 2),
                "itemsCount": len(recommendations)
            })

        # --- CRM & LEADS ENDPOINTS ---
        elif path == "/api/crm/leads":
            leads = load_json("crm_leads.json")
            if not isinstance(leads, list):
                leads = []
            
            stage_filter = qs.get("stage", [None])[0]
            search_query = qs.get("search", [None])[0]

            if stage_filter:
                leads = [l for l in leads if l.get("stage") == stage_filter]
            if search_query:
                sq = search_query.lower()
                leads = [
                    l for l in leads 
                    if sq in l.get("name", "").lower() 
                    or sq in l.get("instagram", "").lower() 
                    or sq in l.get("bio", "").lower()
                    or any(sq in t.lower() for t in l.get("tags", []))
                ]

            return self.send_json({
                "total": len(leads),
                "leads": leads
            })

        elif path == "/api/crm/qualification-rules":
            return self.send_json(load_json("crm_qualification_rules.json"))

        elif path == "/api/scraping/targets":
            return self.send_json(load_json("scraping_targets.json"))

        elif path == "/api/meta-ads/data":
            return self.send_json(load_json("meta_ads_data.json"))

        elif path == "/api/playbook/safe-engagement":
            return self.send_json(load_json("safe_engagement_playbook.json"))

        # --- ERP ROBUSTO ENDPOINTS ---
        elif path == "/api/erp/cnpjs":
            data = load_json("cnpjs_and_stores.json")
            return self.send_json(data)

        elif path == "/api/erp/stores":
            data = load_json("cnpjs_and_stores.json")
            stores = data.get("stores", [])
            cnpj_filter = qs.get("cnpjId", [None])[0]
            if cnpj_filter:
                stores = [s for s in stores if s.get("cnpjId") == cnpj_filter]
            return self.send_json({"total": len(stores), "stores": stores})

        elif path == "/api/erp/accounts-receivable":
            data = load_json("accounts_receivable.json")
            store_filter = qs.get("storeId", [None])[0]
            cnpj_filter = qs.get("cnpjId", [None])[0]
            receivables = data.get("receivables", [])
            if store_filter and store_filter != "ALL":
                receivables = [r for r in receivables if r.get("storeId") == store_filter]
            if cnpj_filter and cnpj_filter != "ALL":
                receivables = [r for r in receivables if r.get("cnpjId") == cnpj_filter]
            
            total_gross = sum(r.get("grossAmount", 0) for r in receivables)
            total_net = sum(r.get("netAmount", 0) for r in receivables)
            total_fees = sum(r.get("feeAmount", 0) for r in receivables)
            settled_net = sum(r.get("netAmount", 0) for r in receivables if r.get("status") == "SETTLED")
            pending_net = sum(r.get("netAmount", 0) for r in receivables if r.get("status") == "PENDING")

            return self.send_json({
                "settlementRules": data.get("settlementRules", {}),
                "receivables": receivables,
                "summary": {
                    "totalGross": round(total_gross, 2),
                    "totalNet": round(total_net, 2),
                    "totalFees": round(total_fees, 2),
                    "settledNet": round(settled_net, 2),
                    "pendingNet": round(pending_net, 2),
                    "count": len(receivables)
                }
            })

        elif path == "/api/erp/accounts-payable":
            data = load_json("accounts_payable.json")
            store_filter = qs.get("storeId", [None])[0]
            cnpj_filter = qs.get("cnpjId", [None])[0]
            payables = data.get("payables", [])
            if store_filter and store_filter != "ALL":
                payables = [p for p in payables if p.get("storeId") == store_filter]
            if cnpj_filter and cnpj_filter != "ALL":
                payables = [p for p in payables if p.get("cnpjId") == cnpj_filter]

            total_amount = sum(p.get("amount", 0) for p in payables)
            paid_amount = sum(p.get("amount", 0) for p in payables if p.get("status") == "PAID")
            pending_amount = sum(p.get("amount", 0) for p in payables if p.get("status") in ["PENDING", "APPROVED"])

            return self.send_json({
                "payables": payables,
                "summary": {
                    "totalAmount": round(total_amount, 2),
                    "paidAmount": round(paid_amount, 2),
                    "pendingAmount": round(pending_amount, 2),
                    "count": len(payables)
                }
            })

        elif path == "/api/erp/bank-reconciliation":
            data = load_json("bank_reconciliation.json")
            return self.send_json(data)

        elif path == "/api/erp/tax-forecast":
            tax_data = load_json("tax_settings.json")
            sales = load_json("mock_stone_sales.json")
            # Calcula faturamento acumulado das vendas registradas
            current_month_sales = sum(s.get("grossAmount", 0) for s in sales)
            # Atualiza dinamicamente se necessário
            forecast = tax_data.get("currentForecast", {})
            if current_month_sales > 0:
                forecast["currentMonthRevenue"] = round(current_month_sales, 2)
                forecast["dasAmountEstimated"] = round(current_month_sales * forecast.get("effectiveTaxRate", 0.055), 2)
                forecast["nfceCount"] = len(sales)
            return self.send_json({
                "regimes": tax_data.get("regimes", {}),
                "currentForecast": forecast
            })

        elif path == "/api/erp/employees":
            data = load_json("employees_and_payroll.json")
            store_filter = qs.get("storeId", [None])[0]
            employees = data.get("employees", [])
            if store_filter and store_filter != "ALL":
                employees = [e for e in employees if e.get("storeId") == store_filter]
            return self.send_json({
                "employees": employees,
                "partnersProLabore": data.get("partnersProLabore", [])
            })

        elif path == "/api/erp/chart-of-accounts":
            data = load_json("chart_of_accounts.json")
            return self.send_json(data)

        elif path == "/api/erp/cost-centers":
            data = load_json("chart_of_accounts.json")
            return self.send_json({"costCenters": data.get("costCenters", [])})

        elif path == "/api/erp/entities":
            data = load_json("contacts_entities.json")
            entities = data.get("entities", [])
            type_filter = qs.get("type", [None])[0]
            cat_filter = qs.get("category", [None])[0]
            search_query = qs.get("search", [None])[0]

            if type_filter and type_filter != "ALL":
                entities = [e for e in entities if e.get("type") == type_filter]
            if cat_filter and cat_filter != "ALL":
                entities = [e for e in entities if e.get("category") == cat_filter]
            if search_query:
                sq = search_query.lower()
                entities = [
                    e for e in entities 
                    if sq in (e.get("name") or e.get("razaoSocial") or "").lower()
                    or sq in (e.get("cpf") or e.get("cnpj") or "").lower()
                    or sq in (e.get("email") or "").lower()
                    or sq in (e.get("city") or "").lower()
                ]

            return self.send_json({
                "total": len(entities),
                "entities": entities
            })

        elif path == "/api/erp/budget/summary":
            data = load_json("budget_scenarios.json")
            return self.send_json(data)

        elif path == "/api/erp/ai-concierge/live-chats":
            data = load_json("live_ai_chats.json")
            return self.send_json(data)

        else:
            return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        
        try:
            payload = json.loads(post_data) if post_data else {}
        except Exception:
            payload = {}

        # --- SUPABASE INTEGRATION ENDPOINTS ---
        if path == "/api/supabase/test":
            if supabase_client:
                return self.send_json(supabase_client.test_connection())
            return self.send_json({"success": False, "error": "supabase_client não inicializado"})

        elif path == "/api/supabase/sync":
            if supabase_client:
                res = supabase_client.sync_all_local_to_supabase(DATA_DIR)
                return self.send_json(res)
            return self.send_json({"success": False, "error": "supabase_client não inicializado"})

        # --- CRM & QUALIFICATION ---
        elif path == "/api/crm/leads/update-stage":
            lead_id = payload.get("leadId")
            new_stage = payload.get("newStage")
            leads = load_json("crm_leads.json")
            updated = False
            for lead in leads:
                if lead["id"] == lead_id:
                    lead["stage"] = new_stage
                    lead["updatedAt"] = datetime.now().isoformat()
                    updated = True
                    break
            if updated:
                save_json("crm_leads.json", leads)
                return self.send_json({"success": True, "leadId": lead_id, "newStage": new_stage})
            return self.send_json({"error": "Lead não encontrado"}, 404)

        elif path == "/api/crm/qualification-rules":
            rules = payload.get("rules", payload)
            rules["lastUpdated"] = datetime.now().isoformat()
            save_json("crm_qualification_rules.json", rules)
            return self.send_json({"success": True, "rules": rules})

        elif path == "/api/crm/recalculate-all-scores":
            rules = load_json("crm_qualification_rules.json")
            leads = load_json("crm_leads.json")
            for lead in leads:
                lead["score"] = calculate_lead_score(lead, rules)
            save_json("crm_leads.json", leads)
            return self.send_json({
                "success": True, 
                "message": f"Scores recalculados para {len(leads)} leads com sucesso!",
                "leads": leads
            })

        # --- SCRAPING TARGETS & AI SUGGESTIONS ---
        elif path == "/api/scraping/targets":
            data = load_json("scraping_targets.json")
            new_target = {
                "id": f"TGT-{len(data.get('targets', [])) + 1:03d}",
                "type": payload.get("type", "PROFILE"),
                "target": payload.get("target", "").replace("@", "").strip(),
                "displayName": payload.get("displayName", payload.get("target")),
                "category": payload.get("category", "Personalizado"),
                "status": "ATIVO",
                "leadsFound": 0,
                "lastScraped": datetime.now().isoformat(),
                "isAiSuggested": payload.get("isAiSuggested", False)
            }
            data["targets"].append(new_target)
            save_json("scraping_targets.json", data)
            return self.send_json({"success": True, "target": new_target})

        elif path == "/api/scraping/suggest-targets":
            # Retorna sugestões da IA com base em nicho
            data = load_json("scraping_targets.json")
            return self.send_json({
                "suggestions": data.get("aiSuggestions", [])
            })

        # --- MANUAL INSTAGRAPI EXECUTION ---
        elif path == "/api/scraping/execute-instagrapi":
            target = payload.get("target", "trackfieldoficial")
            batch_size = int(payload.get("batchSize", 5))
            
            # Simula a extração local segura via instagrapi
            rules = load_json("crm_qualification_rules.json")
            leads = load_json("crm_leads.json")
            
            mock_pool = [
                {
                    "name": "Dra. Carolina Mendes",
                    "instagram": "dra.carol_cardio",
                    "avatar": "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150&auto=format&fit=crop&q=80",
                    "bio": "Cardiologista • Especialista em Atletas 🩺 | Triatleta Amadora 🏊‍♀️🚴‍♀️🏃‍♀️ | Floripa",
                    "phone": "48997788112",
                    "email": "carolina@cardiofloripa.com",
                    "city": "Florianópolis",
                    "followers": 14200,
                    "tags": ["Médica", "Cardiologista", "Triatlo", "Florianópolis"],
                    "source": f"instagrapi: @{target}"
                },
                {
                    "name": "Isabela Schütz",
                    "instagram": "isaschutz_pilates",
                    "avatar": "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80",
                    "bio": "Studio Reformer Pilates Clássico 🩰 | Aluna JOY Wellness | Jurerê / Centro Floripa",
                    "phone": "48996655443",
                    "email": "isabela@schutzpilates.com.br",
                    "city": "Florianópolis",
                    "followers": 8700,
                    "tags": ["Pilates", "Reformer", "JOY Member", "Jurerê"],
                    "source": f"instagrapi: @{target}"
                },
                {
                    "name": "Tatiana Guimarães",
                    "instagram": "tatiguimaraes_bt",
                    "avatar": "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80",
                    "bio": "Atleta Beach Tennis Pro/Am 🎾 | Estilo de vida saudável & Nutrição | Balneário Camboriú",
                    "phone": "47998811223",
                    "email": "tati@btlifestyle.com",
                    "city": "Balneário Camboriú",
                    "followers": 19400,
                    "tags": ["Beach Tennis", "Atleta", "Balneário Camboriú"],
                    "source": f"instagrapi: @{target}"
                }
            ]
            
            created_leads = []
            for item in mock_pool[:batch_size]:
                # Verificar se já existe
                if not any(l.get("instagram") == item["instagram"] for l in leads):
                    new_id = f"LEAD-{len(leads) + 1:03d}"
                    lead_obj = {
                        "id": new_id,
                        **item,
                        "score": 5,
                        "stage": "QUALIFICADO",
                        "instagramEngagement": {
                            "storyViewed": False,
                            "postLiked": False,
                            "followed": False,
                            "followedBack": False,
                            "directSent": False
                        },
                        "stonePurchases": [],
                        "interactions": [],
                        "discoveredAt": datetime.now().isoformat()
                    }
                    lead_obj["score"] = calculate_lead_score(lead_obj, rules)
                    leads.insert(0, lead_obj)
                    created_leads.append(lead_obj)
            
            save_json("crm_leads.json", leads)
            
            return self.send_json({
                "success": True,
                "engine": "instagrapi (Python Local)",
                "target": target,
                "status": "COMPLETED",
                "extractedCount": len(created_leads),
                "safeDelayApplied": "4.2s entre requisições",
                "newLeads": created_leads,
                "message": f"Extração local via instagrapi concluída com sucesso! {len(created_leads)} novos leads qualificados adicionados ao CRM."
            })

        # --- APIFY CLOUD SCRAPING ---
        elif path == "/api/scraping/execute-apify":
            target = payload.get("target", "trackfieldoficial")
            return self.send_json({
                "success": True,
                "engine": "Apify Cloud Actor (Residential Mobile Proxies 4G)",
                "actorId": "apify/instagram-scraper-v3",
                "runId": f"run_apify_{int(datetime.now().timestamp())}",
                "target": target,
                "status": "PROCESSING",
                "message": f"Job Apify iniciado com sucesso para @{target}! Os leads serão entregues via webhook assim que a extração for concluída."
            })

        # --- META ADS MARKETING API ---
        elif path == "/api/meta-ads/sync-audience":
            leads = load_json("crm_leads.json")
            qualified = [l for l in leads if l.get("score", 0) >= 4]
            
            # Hashing SHA-256 de e-mails e telefones conforme especificação da Meta Marketing API
            hashed_records = []
            for l in qualified:
                phone = "".join(filter(str.isdigit, l.get("phone", "")))
                email = (l.get("email") or "").strip().lower()
                
                h_phone = hashlib.sha256(phone.encode("utf-8")).hexdigest() if phone else None
                h_email = hashlib.sha256(email.encode("utf-8")).hexdigest() if email else None
                
                if h_phone or h_email:
                    hashed_records.append({"phoneHash": h_phone, "emailHash": h_email, "id": l["id"]})
                    
            ads_data = load_json("meta_ads_data.json")
            if "customAudiences" in ads_data and len(ads_data["customAudiences"]) > 0:
                ads_data["customAudiences"][0]["size"] = len(hashed_records)
                ads_data["customAudiences"][0]["lastSync"] = datetime.now().isoformat()
                save_json("meta_ads_data.json", ads_data)
                
            return self.send_json({
                "success": True,
                "audienceId": "AUD-001",
                "audienceName": "SIÉ Joy - Leads Qualificados CRM (Score 4-5)",
                "syncedRecords": len(hashed_records),
                "hashingAlgorithm": "SHA-256",
                "metaApiEndpoint": "/v19.0/act_98124401/customaudiences",
                "message": f"Público Personalizado sincronizado com a Meta! {len(hashed_records)} leads criptografados enviados com sucesso."
            })

        # --- PLAYBOOK SAFE ENGAGEMENT ---
        elif path == "/api/playbook/update-action":
            action_type = payload.get("actionType") # storiesViewed, postsLiked, followed, directsSent
            lead_id = payload.get("leadId")
            
            playbook = load_json("safe_engagement_playbook.json")
            if action_type in playbook.get("todayCounters", {}):
                playbook["todayCounters"][action_type] += 1
                save_json("safe_engagement_playbook.json", playbook)
                
            if lead_id:
                leads = load_json("crm_leads.json")
                for lead in leads:
                    if lead["id"] == lead_id:
                        eng = lead.setdefault("instagramEngagement", {})
                        if action_type == "storiesViewed": eng["storyViewed"] = True
                        elif action_type == "postsLiked": eng["postLiked"] = True
                        elif action_type == "followed": eng["followed"] = True
                        elif action_type == "directsSent": eng["directSent"] = True
                        break
                save_json("crm_leads.json", leads)
                
            return self.send_json({
                "success": True,
                "todayCounters": playbook.get("todayCounters"),
                "leadId": lead_id
            })

        # --- STONE WEBHOOK SIMULATION ---
        elif path == "/api/stone/simulate-webhook":
            sales = load_json("mock_stone_sales.json")
            catalog = load_json("stone_catalog.json")

            tx_id = f"TX-STONE-{len(sales) + 9801}"
            gross = float(payload.get("grossAmount", 289.00))
            method = payload.get("paymentMethod", "PIX")
            
            fee_rates = {"PIX": 0.00, "DEBIT": 0.0089, "CREDIT_CARD": 0.0318}
            fee_rate = fee_rates.get(method, 0.0318)
            net = round(gross * (1 - fee_rate), 2)
            
            sales_person = payload.get("salesPerson", "Vendedora Titular")
            commission = round(gross * 0.03, 2) if sales_person == "Vendedora Titular" else 0.00

            product_sku = payload.get("sku", "SIE-LEG-SCULPT-BLK")
            product_size = payload.get("size", "M")

            for p in catalog:
                if p["stoneSku"] == product_sku:
                    if p["currentStock"].get(product_size, 0) > 0:
                        p["currentStock"][product_size] -= 1
                    break
            save_json("stone_catalog.json", catalog)

            new_tx = {
                "id": tx_id,
                "timestamp": datetime.now().isoformat(),
                "customer": payload.get("customer", { "name": "Aluna JOY VIP", "phone": "48999001122", "joyPlan": "Wellness Club" }),
                "channel": payload.get("channel", "POS_BALCAO"),
                "device": payload.get("device", "Stone Smart POS P2 #01"),
                "paymentMethod": method,
                "installments": int(payload.get("installments", 1)),
                "grossAmount": gross,
                "feeRate": fee_rate,
                "netAmount": net,
                "status": "PAID",
                "salesPerson": sales_person,
                "commissionAmount": commission,
                "deliveryMode": payload.get("deliveryMode", "Retirada Balcão JOY"),
                "items": payload.get("items", [
                    { "name": payload.get("productName", "Peça SIÉ Wear"), "sku": product_sku, "size": product_size, "qty": 1, "price": gross }
                ])
            }

            sales.insert(0, new_tx)
            save_json("mock_stone_sales.json", sales)

            return self.send_json({
                "success": True,
                "webhookEvent": "charge.paid",
                "transaction": new_tx,
                "message": f"Webhook Stone recebido com sucesso! Venda de R$ {gross:,.2f} contabilizada."
            })

        elif path == "/api/stone/generate-payment-link":
            amount = float(payload.get("amount", 289.00))
            desc = payload.get("description", "Look SIÉ Wear @ JOY Wellness")
            link_id = f"link_stone_{int(datetime.now().timestamp())}"
            payment_url = f"https://pay.stone.com.br/{link_id}"
            
            return self.send_json({
                "success": True,
                "paymentLinkId": link_id,
                "paymentUrl": payment_url,
                "qrCodePix": "00020126580014br.gov.bcb.pix0136sie-joy-stone-recebimentos@siewear.com5204000053039865405" + str(int(amount*100)) + "5802BR5925SIE WEAR JOY FLORIANOPOLIS6014FLORIANOPOLIS62070503***6304ABCD",
                "expiresAt": "24 horas",
                "status": "ACTIVE"
            })

        # --- HERME AGENT (WHATSAPP CLOUD API + ERP + VENDEDOR) ---
        elif path == "/api/whatsapp/chat":
            user_msg = payload.get("message", "").strip().lower()
            customer_name = payload.get("customerName", "Aluna")
            lead_id = payload.get("leadId")
            
            catalog = load_json("stone_catalog.json")

            # Herme Agent ERP & Vendedor
            if any(w in user_msg for w in ["olá", "ola", "oi", "bom dia", "boa tarde", "boa noite"]):
                bot_reply = f"Olá, {customer_name}! ✨ Sou o **Herme Agent**, Concierge de Luxo e Consultor da **SIÉ Wear @ JOY Wellness Club**.\n\nComo posso cuidar do seu visual de treino hoje? Você gostaria de ver novidades para **Pilates Reformer**, **Musculação de Alta Performance**, **Beach Tennis** ou agendar seu look no **Armário VIP da JOY**?"
                suggestions = ["Pilates Reformer", "Musculação", "Ver Estoque P/M/G", "Calcular Entrega"]
                recommended_product = None

            elif any(w in user_msg for w in ["pilates", "reformer", "alongamento"]):
                p = next((x for x in catalog if x["id"] == "PROD-004"), catalog[0])
                stock_str = ", ".join([f"{size}: {qty} un." for size, qty in p["currentStock"].items()])
                bot_reply = f"Para suas sessões no Reformer da JOY, nossa peça mais desejada é o **{p['name']}** ({p['color']}). Ele tem elasticidade 360°, toque acetinado e costuras planas antifricção.\n\n💎 **Preço:** R$ {p['price']:,.2f}\n📦 **Estoque ao Vivo na JOY:** {stock_str}\n\nVocê gostaria de experimentar no clube ou prefere entrega por motoboy VIP?"
                suggestions = ["Reservar no Armário JOY", "Pagar pelo Link Stone", "Calcular Entrega"]
                recommended_product = p

            elif any(w in user_msg for w in ["musculação", "musculacao", "treino pesado", "perna", "agachamento", "legging"]):
                p = next((x for x in catalog if x["id"] == "PROD-001"), catalog[0])
                stock_str = ", ".join([f"{size}: {qty} un." for size, qty in p["currentStock"].items()])
                bot_reply = f"Para treino de musculação, recomendo a **{p['name']}** ({p['color']})! Ela conta com nossa tecnologia Zero Transparência testada em agachamento profundo e cós anatômico modelador.\n\n💎 **Preço:** R$ {p['price']:,.2f}\n📦 **Estoque em Loja:** {stock_str}\n\nPosso emitir o link de pagamento com cartão até 3x pela Stone ou separar uma peça para você na JOY?"
                suggestions = ["Gerar Link Stone", "Reservar Armário VIP", "Calcular Entrega"]
                recommended_product = p

            elif any(w in user_msg for w in ["entrega", "frete", "motoboy", "envio", "calcular"]):
                bot_reply = "Trabalhamos com 3 modalidades exclusivas de entrega:\n\n1. 🛵 **Motoboy VIP Express (Florianópolis e São José):** R$ 25,00 (Entrega em até 3 horas com sacola de luxo perfumada).\n2. 📦 **Sedex Express (SC e RS):** R$ 32,00 (1 a 2 dias úteis).\n3. 🎀 **Retirada Grátis no Armário VIP da JOY:** R$ 0,00 (Peça separada no vestiário exclusivo do clube para você experimentar após o treino).\n\nQual opção fica melhor para sua rotina?"
                suggestions = ["Armário VIP (Grátis)", "Motoboy VIP Floripa", "Sedex RS/SC"]
                recommended_product = None

            elif any(w in user_msg for w in ["armário", "armario", "reservar"]):
                bot_reply = f"Perfeito, {customer_name}! Serviço **Armário VIP Ativado** 🎀\n\nNossa vendedora titular na boutique JOY já foi notificada no balcão e deixará o seu look separado no seu armário até às 11h, com tags aromáticas exclusivas SIÉ.\n\nVocê experimenta com total conforto. Se gostar, é só escanear a maquininha Stone ou me avisar por aqui para pagar pelo link!"
                suggestions = ["Confirmar Reserva", "Pagar pelo Link Stone", "Falar com Vendedora"]
                recommended_product = None

            elif any(w in user_msg for w in ["pagar", "link", "pix", "cartão", "cartao", "comprar"]):
                p = next((x for x in catalog if x["id"] == "PROD-001"), catalog[0])
                link_url = f"https://pay.stone.com.br/sie_vip_{int(datetime.now().timestamp())}"
                bot_reply = f"Aqui está o seu **Link de Pagamento Oficial Stone**:\n\n👉 **{link_url}**\n\n- **Valor:** R$ {p['price']:,.2f}\n- **Condições:** Pix instantâneo ou até 3x sem juros no Cartão de Crédito.\n- **Garantia:** Processado pela StoneCo com emissão automática de NFC-e."
                suggestions = ["Pagamento Efetuado", "Adicionar Jaqueta Bomber", "Retirar na Loja"]
                recommended_product = p

            else:
                bot_reply = f"Com certeza! Como consultor de estilo da SIÉ Wear, posso verificar a disponibilidade exata de qualquer look no nosso ERP, calcular frete ou deixar o look separado no clube JOY para você.\n\nQual categoria você gostaria de ver agora?"
                suggestions = ["Leggings", "Tops", "Macaquinhos", "Calcular Entrega"]
                recommended_product = None

            # Salvar interação no histórico do lead se lead_id fornecido
            if lead_id:
                leads = load_json("crm_leads.json")
                for lead in leads:
                    if lead["id"] == lead_id:
                        lead.setdefault("interactions", []).append({
                            "date": datetime.now().isoformat(),
                            "sender": "Lead",
                            "channel": "WhatsApp",
                            "message": user_msg
                        })
                        lead["interactions"].append({
                            "date": datetime.now().isoformat(),
                            "sender": "Herme Agent",
                            "channel": "WhatsApp",
                            "message": bot_reply
                        })
                        lead["stage"] = "EM_CONTATO_IA"
                        break
                save_json("crm_leads.json", leads)

            return self.send_json({
                "response": bot_reply,
                "suggestions": suggestions,
                "recommendedProduct": recommended_product,
                "sender": "Herme Agent (IA Concierge & Vendedor)",
                "timestamp": datetime.now().isoformat()
            })

        # --- ERP ROBUSTO POST ENDPOINTS ---
        elif path == "/api/erp/cnpjs":
            data = load_json("cnpjs_and_stores.json")
            new_cnpj = {
                "id": payload.get("id") or f"cnpj-{len(data.get('cnpjs', [])) + 1:02d}",
                "cnpj": payload.get("cnpj", "").strip(),
                "razaoSocial": payload.get("razaoSocial", "").strip(),
                "nomeFantasia": payload.get("nomeFantasia", "").strip(),
                "ie": payload.get("ie", "").strip(),
                "taxRegime": payload.get("taxRegime", "SIMPLES_NACIONAL"),
                "taxRate": float(payload.get("taxRate", 0.055)),
                "address": payload.get("address", "").strip(),
                "digitalCertificateExpires": payload.get("digitalCertificateExpires", "2027-12-31"),
                "cnae": payload.get("cnae", "47.81-4-00 - Comércio varejista de artigos do vestuário e acessórios"),
                "status": "ACTIVE"
            }
            # Check if updating or adding
            existing = False
            for i, c in enumerate(data.get("cnpjs", [])):
                if c["id"] == new_cnpj["id"] or c["cnpj"] == new_cnpj["cnpj"]:
                    data["cnpjs"][i] = new_cnpj
                    existing = True
                    break
            if not existing:
                data.setdefault("cnpjs", []).append(new_cnpj)
            save_json("cnpjs_and_stores.json", data)
            return self.send_json({"success": True, "cnpj": new_cnpj, "action": "updated" if existing else "created"})

        elif path == "/api/erp/stores":
            data = load_json("cnpjs_and_stores.json")
            new_store = {
                "id": payload.get("id") or f"store-{len(data.get('stores', [])) + 1:02d}",
                "cnpjId": payload.get("cnpjId", "cnpj-01"),
                "name": payload.get("name", "").strip(),
                "type": payload.get("type", "CORNER"),
                "location": payload.get("location", "").strip(),
                "city": payload.get("city", "").strip(),
                "stoneCode": payload.get("stoneCode", "").strip(),
                "terminals": payload.get("terminals", ["Smart POS P2"]),
                "rentAmount": float(payload.get("rentAmount", 0.0)),
                "gracePeriodRemainingMonths": int(payload.get("gracePeriodRemainingMonths", 0)),
                "salesTargetMonthly": float(payload.get("salesTargetMonthly", 50000.0)),
                "status": "ACTIVE"
            }
            existing = False
            for i, s in enumerate(data.get("stores", [])):
                if s["id"] == new_store["id"]:
                    data["stores"][i] = new_store
                    existing = True
                    break
            if not existing:
                data.setdefault("stores", []).append(new_store)
            save_json("cnpjs_and_stores.json", data)
            return self.send_json({"success": True, "store": new_store, "action": "updated" if existing else "created"})

        elif path == "/api/erp/accounts-receivable/settings":
            data = load_json("accounts_receivable.json")
            if "settlementRules" in payload:
                data["settlementRules"] = payload["settlementRules"]
            elif "method" in payload and "rule" in payload:
                data.setdefault("settlementRules", {})[payload["method"]] = payload["rule"]
            save_json("accounts_receivable.json", data)
            return self.send_json({"success": True, "settlementRules": data.get("settlementRules", {})})

        elif path == "/api/erp/accounts-receivable/create":
            data = load_json("accounts_receivable.json")
            rec_id = f"REC-{len(data.get('receivables', [])) + 9810}"
            gross = float(payload.get("grossAmount", 0))
            method = payload.get("paymentMethod", "CORPORATE_INVOICE")
            rules = data.get("settlementRules", {})
            rule = rules.get(method, {"daysOffset": 30, "mdrRate": 0.0, "mode": "D+30"})
            fee_rate = rule.get("mdrRate", 0.0)
            fee_amount = round(gross * fee_rate, 2)
            net_amount = round(gross - fee_amount, 2)

            new_rec = {
                "id": rec_id,
                "saleCode": payload.get("saleCode", f"FAT-{datetime.now().strftime('%Y%m%d%H%M')}"),
                "storeId": payload.get("storeId", "store-01"),
                "cnpjId": payload.get("cnpjId", "cnpj-01"),
                "customerName": payload.get("customerName", "Cliente Corporativo"),
                "paymentMethod": method,
                "installments": int(payload.get("installments", 1)),
                "saleDate": datetime.now().isoformat(),
                "expectedSettlementDate": payload.get("expectedSettlementDate", datetime.now().strftime("%Y-%m-%d")),
                "grossAmount": gross,
                "feeRate": fee_rate,
                "feeAmount": fee_amount,
                "netAmount": net_amount,
                "settlementMode": rule.get("mode", "D+0"),
                "status": "PENDING"
            }
            data.setdefault("receivables", []).insert(0, new_rec)
            save_json("accounts_receivable.json", data)
            return self.send_json({"success": True, "receivable": new_rec})

        elif path == "/api/erp/accounts-payable":
            data = load_json("accounts_payable.json")
            new_id = f"PAG-{len(data.get('payables', [])) + 1:03d}"
            new_pag = {
                "id": new_id,
                "storeId": payload.get("storeId", "store-01"),
                "cnpjId": payload.get("cnpjId", "cnpj-01"),
                "category": payload.get("category", "FORNECEDOR_CMV"),
                "supplier": payload.get("supplier", "").strip(),
                "description": payload.get("description", "").strip(),
                "documentNumber": payload.get("documentNumber", "").strip(),
                "issueDate": payload.get("issueDate", datetime.now().strftime("%Y-%m-%d")),
                "dueDate": payload.get("dueDate", datetime.now().strftime("%Y-%m-%d")),
                "amount": float(payload.get("amount", 0.0)),
                "paymentMethod": payload.get("paymentMethod", "BOLETO"),
                "status": "PENDING",
                "notes": payload.get("notes", "")
            }
            data.setdefault("payables", []).append(new_pag)
            save_json("accounts_payable.json", data)
            return self.send_json({"success": True, "payable": new_pag})

        elif path == "/api/erp/accounts-payable/pay":
            payable_id = payload.get("payableId")
            new_status = payload.get("status", "PAID")
            data = load_json("accounts_payable.json")
            updated = False
            for p in data.get("payables", []):
                if p["id"] == payable_id:
                    p["status"] = new_status
                    p["paidAt"] = datetime.now().isoformat()
                    updated = True
                    break
            if updated:
                save_json("accounts_payable.json", data)
                return self.send_json({"success": True, "payableId": payable_id, "status": new_status})
            return self.send_json({"error": "Título a pagar não encontrado"}, 404)

        elif path == "/api/erp/bank-reconciliation/match":
            match_id = payload.get("matchId")
            data = load_json("bank_reconciliation.json")
            updated = False
            for m in data.get("reconciledTransactions", []):
                if m["id"] == match_id:
                    m["status"] = "CONCILIADO"
                    m["bankStatementAmount"] = m["stoneSettledAmount"]
                    m["difference"] = 0.0
                    m["notes"] = "Conciliado manualmente pelo operador financeiro"
                    updated = True
                    break
            if updated:
                save_json("bank_reconciliation.json", data)
                return self.send_json({"success": True, "matchId": match_id, "status": "CONCILIADO"})
            return self.send_json({"error": "Item de conciliação não encontrado"}, 404)

        elif path == "/api/erp/employees":
            data = load_json("employees_and_payroll.json")
            emp_id = payload.get("id") or f"emp-{len(data.get('employees', [])) + 1:03d}"
            base_sal = float(payload.get("baseSalary", 2000.0))
            new_emp = {
                "id": emp_id,
                "name": payload.get("name", "").strip(),
                "cpf": payload.get("cpf", "").strip(),
                "role": payload.get("role", "Consultora de Vendas").strip(),
                "storeId": payload.get("storeId", "store-01"),
                "cnpjId": payload.get("cnpjId", "cnpj-01"),
                "baseSalary": base_sal,
                "commissionRates": {
                    "posDirect": float(payload.get("commissionPosDirect", 0.03)),
                    "waLink": float(payload.get("commissionWaLink", 0.03))
                },
                "workSchedule": payload.get("workSchedule", "Segunda a Sexta: 10h00 às 16h00 (6h)"),
                "admissionDate": payload.get("admissionDate", datetime.now().strftime("%Y-%m-%d")),
                "vacationInfo": payload.get("vacationInfo", {
                    "acquisitionPeriodStart": datetime.now().strftime("%Y-%m-%d"),
                    "acquisitionPeriodEnd": "2027-08-01",
                    "daysBalance": 30,
                    "concessivePeriodDeadline": "2028-08-01",
                    "scheduledPeriods": [],
                    "status": "ACQUIRING"
                }),
                "payrollCurrentMonth": {
                    "baseSalary": base_sal,
                    "posSalesAmount": 0.0,
                    "posCommission": 0.0,
                    "waSalesAmount": 0.0,
                    "waCommission": 0.0,
                    "totalCommission": 0.0,
                    "dsrAmount": 0.0,
                    "grossTotal": base_sal,
                    "inssDeduction": round(base_sal * 0.08, 2),
                    "irrfDeduction": 0.0,
                    "netSalary": round(base_sal * 0.92, 2),
                    "fgtsDeposit": round(base_sal * 0.08, 2),
                    "provision13th": round(base_sal / 12, 2),
                    "provisionVacation": round((base_sal * 1.3333) / 12, 2)
                },
                "status": "ACTIVE"
            }
            existing = False
            for i, e in enumerate(data.get("employees", [])):
                if e["id"] == emp_id:
                    data["employees"][i] = new_emp
                    existing = True
                    break
            if not existing:
                data.setdefault("employees", []).append(new_emp)
            save_json("employees_and_payroll.json", data)
            return self.send_json({"success": True, "employee": new_emp, "action": "updated" if existing else "created"})

        elif path == "/api/erp/employees/vacation":
            emp_id = payload.get("employeeId")
            vacation_start = payload.get("startDate")
            vacation_days = int(payload.get("days", 30))
            data = load_json("employees_and_payroll.json")
            updated = False
            for e in data.get("employees", []):
                if e["id"] == emp_id:
                    v_info = e.setdefault("vacationInfo", {})
                    v_info.setdefault("scheduledPeriods", []).append({
                        "startDate": vacation_start,
                        "days": vacation_days,
                        "scheduledAt": datetime.now().isoformat()
                    })
                    v_info["daysBalance"] = max(v_info.get("daysBalance", 30) - vacation_days, 0)
                    v_info["status"] = "SCHEDULED"
                    updated = True
                    break
            if updated:
                save_json("employees_and_payroll.json", data)
                return self.send_json({"success": True, "employeeId": emp_id, "vacationInfo": v_info})
            return self.send_json({"error": "Funcionário não encontrado"}, 404)

        # --- ENTITIES & CADASTROS POST ---
        elif path == "/api/erp/entities":
            data = load_json("contacts_entities.json")
            new_id = payload.get("id") or f"ENT-{len(data.get('entities', [])) + 1:03d}"
            entity_type = payload.get("type", "PF")
            
            if entity_type == "PF":
                new_ent = {
                    "id": new_id,
                    "type": "PF",
                    "name": payload.get("name", "").strip(),
                    "cpf": payload.get("cpf", "").strip(),
                    "rg": payload.get("rg", "").strip(),
                    "birthDate": payload.get("birthDate", ""),
                    "phone": payload.get("phone", "").strip(),
                    "email": payload.get("email", "").strip(),
                    "city": payload.get("city", "").strip(),
                    "address": payload.get("address", "").strip(),
                    "category": payload.get("category", "CLIENTE_VIP"),
                    "relationship": payload.get("relationship", "Cliente"),
                    "notes": payload.get("notes", ""),
                    "totalSpent": float(payload.get("totalSpent", 0.0)),
                    "stoneSynced": payload.get("stoneSynced", False),
                    "createdAt": datetime.now().isoformat()
                }
            else:
                new_ent = {
                    "id": new_id,
                    "type": "PJ",
                    "razaoSocial": payload.get("razaoSocial", "").strip(),
                    "nomeFantasia": payload.get("nomeFantasia", "").strip(),
                    "cnpj": payload.get("cnpj", "").strip(),
                    "ie": payload.get("ie", "ISENTO").strip(),
                    "im": payload.get("im", "").strip(),
                    "taxRegime": payload.get("taxRegime", "SIMPLES_NACIONAL"),
                    "responsibleName": payload.get("responsibleName", "").strip(),
                    "phone": payload.get("phone", "").strip(),
                    "email": payload.get("email", "").strip(),
                    "city": payload.get("city", "").strip(),
                    "address": payload.get("address", "").strip(),
                    "category": payload.get("category", "FORNECEDOR_CMV"),
                    "relationship": payload.get("relationship", "Fornecedor"),
                    "paymentCondition": payload.get("paymentCondition", "30 dias"),
                    "notes": payload.get("notes", ""),
                    "stoneSynced": False,
                    "createdAt": datetime.now().isoformat()
                }

            existing = False
            for i, e in enumerate(data.get("entities", [])):
                if e["id"] == new_id or (entity_type == "PF" and e.get("cpf") and e.get("cpf") == new_ent.get("cpf")) or (entity_type == "PJ" and e.get("cnpj") and e.get("cnpj") == new_ent.get("cnpj")):
                    data["entities"][i] = new_ent
                    existing = True
                    break
            if not existing:
                data.setdefault("entities", []).insert(0, new_ent)
            save_json("contacts_entities.json", data)

            # Sincronização Unificada com Equipe & RH se categoria for COLABORADOR ou VENDEDOR_COMISSIONADO
            if entity_type == "PF" and new_ent.get("category") in ["COLABORADOR", "VENDEDOR_COMISSIONADO"]:
                emp_data = load_json("employees_and_payroll.json")
                emp_list = emp_data.setdefault("employees", [])
                contract_type = payload.get("contractType", "CLT_FIXED_COMMISSION")
                base_sal = float(payload.get("baseSalary", 0.0))
                emp_role = payload.get("role", "Consultora de Vendas").strip()
                pos_rate = float(payload.get("commissionRatePos", 3.0)) / 100.0
                wa_rate = float(payload.get("commissionRateWa", 3.0)) / 100.0
                emp_store = payload.get("storeId", "store-01")

                matching_emp = next((x for x in emp_list if x.get("cpf") == new_ent.get("cpf")), None)
                if matching_emp:
                    matching_emp["name"] = new_ent.get("name")
                    matching_emp["role"] = emp_role
                    matching_emp["contractType"] = contract_type
                    matching_emp["contractLabel"] = "Comissionado Puro (100% Comissão)" if contract_type == "COMMISSION_ONLY" else "CLT (Fixo + Comissão)"
                    matching_emp["baseSalary"] = base_sal
                    matching_emp["commissionRates"] = {"posDirect": pos_rate, "waLink": wa_rate}
                    matching_emp["storeId"] = emp_store
                else:
                    new_emp_obj = {
                        "id": f"emp-{len(emp_list) + 1:03d}",
                        "name": new_ent.get("name"),
                        "cpf": new_ent.get("cpf"),
                        "role": emp_role,
                        "contractType": contract_type,
                        "contractLabel": "Comissionado Puro (100% Comissão)" if contract_type == "COMMISSION_ONLY" else "CLT (Fixo + Comissão)",
                        "storeId": emp_store,
                        "cnpjId": "cnpj-01",
                        "baseSalary": base_sal,
                        "commissionRates": {"posDirect": pos_rate, "waLink": wa_rate},
                        "workSchedule": payload.get("workSchedule", "Turno de 6h"),
                        "admissionDate": datetime.now().strftime("%Y-%m-%d"),
                        "vacationInfo": {
                            "daysBalance": 30 if contract_type != "COMMISSION_ONLY" else 0,
                            "status": "ACQUIRING" if contract_type != "COMMISSION_ONLY" else "NOT_APPLICABLE"
                        },
                        "payrollCurrentMonth": {
                            "baseSalary": base_sal,
                            "posSalesAmount": 0.0,
                            "posCommission": 0.0,
                            "waSalesAmount": 0.0,
                            "waCommission": 0.0,
                            "totalCommission": 0.0,
                            "dsrAmount": 0.0,
                            "grossTotal": base_sal,
                            "inssDeduction": round(base_sal * 0.08, 2) if contract_type != "COMMISSION_ONLY" else 0.0,
                            "irrfDeduction": 0.0,
                            "netSalary": round(base_sal * 0.92, 2) if contract_type != "COMMISSION_ONLY" else 0.0,
                            "fgtsDeposit": round(base_sal * 0.08, 2) if contract_type != "COMMISSION_ONLY" else 0.0,
                            "provision13th": round(base_sal / 12, 2) if contract_type != "COMMISSION_ONLY" else 0.0,
                            "provisionVacation": round((base_sal * 1.3333) / 12, 2) if contract_type != "COMMISSION_ONLY" else 0.0
                        },
                        "status": "ACTIVE"
                    }
                    emp_list.append(new_emp_obj)
                save_json("employees_and_payroll.json", emp_data)

            return self.send_json({"success": True, "entity": new_ent, "action": "updated" if existing else "created"})

        elif path == "/api/erp/sync-stone-customers":
            sales = load_json("mock_stone_sales.json")
            entities_data = load_json("contacts_entities.json")
            entities = entities_data.setdefault("entities", [])
            
            synced_count = 0
            for sale in sales:
                customer = sale.get("customer", {})
                cust_name = customer.get("name")
                if not cust_name:
                    continue
                exists = any(e.get("name") == cust_name for e in entities)
                if not exists:
                    new_ent = {
                        "id": f"ENT-{len(entities) + 1:03d}",
                        "type": "PF",
                        "name": cust_name,
                        "cpf": "000.000.000-00",
                        "phone": customer.get("phone", ""),
                        "email": f"{cust_name.lower().replace(' ', '')}@cliente.stone.com",
                        "city": "Florianópolis/SC",
                        "category": "CLIENTE_VIP",
                        "relationship": f"Cliente Stone POS ({customer.get('joyPlan', 'Varejo')})",
                        "notes": f"Puxado automaticamente da maquininha Stone via transação {sale.get('id')}.",
                        "totalSpent": float(sale.get("grossAmount", 0.0)),
                        "stoneSynced": True,
                        "createdAt": datetime.now().isoformat()
                    }
                    entities.insert(0, new_ent)
                    synced_count += 1

            save_json("contacts_entities.json", entities_data)
            return self.send_json({
                "success": True,
                "syncedCount": synced_count,
                "message": f"{synced_count} clientes importados da maquininha Stone com sucesso!"
            })

        # --- CHAT IA AO VIVO: TOGGLE MODO HUMANO / IA ---
        elif path == "/api/erp/ai-concierge/toggle-mode":
            chat_id = payload.get("chatId")
            target_mode = payload.get("targetMode", "HUMAN")
            agent_name = payload.get("agentName", "Mariana Ramos (Consultora Titular)")
            data = load_json("live_ai_chats.json")
            updated = False
            for c in data.get("chats", []):
                if c["id"] == chat_id:
                    if target_mode == "HUMAN":
                        c["mode"] = "HUMAN"
                        c["status"] = "HUMAN_ACTIVE"
                        c["statusLabel"] = "👤 Em Atendimento Humano"
                        c["assignedAgent"] = agent_name
                    else:
                        c["mode"] = "AI"
                        c["status"] = "AI_ACTIVE"
                        c["statusLabel"] = "🤖 Em Atendimento IA"
                        c["assignedAgent"] = "Herme Agent IA Concierge"
                    updated = True
                    break
            if updated:
                active = len([c for c in data["chats"] if "ACTIVE" in c.get("status", "")])
                pending_h = len([c for c in data["chats"] if c.get("status") == "WAITING_HUMAN"])
                data["kpis"]["activeChats"] = active
                data["kpis"]["pendingHumanTakeover"] = pending_h
                save_json("live_ai_chats.json", data)
                return self.send_json({"success": True, "chatId": chat_id, "mode": target_mode})
            return self.send_json({"error": "Chat não encontrado"}, 404)

        # --- CONCILIAÇÃO BANCÁRIA: APROVAÇÃO HUMANA ---
        elif path == "/api/erp/bank-reconciliation/approve":
            match_ids = payload.get("matchIds", [])
            approved_by = payload.get("approvedBy", "Paulo Júnior (Diretor Executivo)")
            data = load_json("bank_reconciliation.json")
            approved_count = 0
            for m in data.get("reconciledTransactions", []):
                if m["id"] in match_ids:
                    m["approvalStatus"] = "APPROVED"
                    m["approvedBy"] = approved_by
                    m["approvedAt"] = datetime.now().isoformat()
                    m["difference"] = 0.0
                    m["bankStatementAmount"] = m["stoneSettledAmount"]
                    approved_count += 1
            save_json("bank_reconciliation.json", data)
            return self.send_json({"success": True, "approvedCount": approved_count, "approvedBy": approved_by})

        # --- ESTIMATIVA AUTOMÁTICA DE ALÍQUOTA TRIBUTÁRIA ---
        elif path == "/api/erp/tax/calculate-estimate":
            regime = payload.get("regime", "SIMPLES_NACIONAL")
            rbt12 = float(payload.get("rbt12", 420000.0))
            city = payload.get("city", "Florianópolis/SC")

            if regime == "SIMPLES_NACIONAL":
                if rbt12 <= 180000:
                    nominal, ded = 0.040, 0.0
                    bracket_name = "1ª Faixa (até R$ 180k)"
                elif rbt12 <= 360000:
                    nominal, ded = 0.073, 5940.0
                    bracket_name = "2ª Faixa (R$ 180k a R$ 360k)"
                elif rbt12 <= 720000:
                    nominal, ded = 0.095, 13860.0
                    bracket_name = "3ª Faixa (R$ 360k a R$ 720k)"
                elif rbt12 <= 1800000:
                    nominal, ded = 0.107, 22500.0
                    bracket_name = "4ª Faixa (R$ 720k a R$ 1.8M)"
                elif rbt12 <= 3600000:
                    nominal, ded = 0.143, 87300.0
                    bracket_name = "5ª Faixa (R$ 1.8M a R$ 3.6M)"
                else:
                    nominal, ded = 0.190, 378000.0
                    bracket_name = "6ª Faixa (R$ 3.6M a R$ 4.8M)"
                
                effective_rate = ((rbt12 * nominal) - ded) / rbt12 if rbt12 > 0 else 0.04
                effective_pct = round(effective_rate * 100, 2)
                return self.send_json({
                    "success": True,
                    "regime": "SIMPLES_NACIONAL",
                    "rbt12": rbt12,
                    "bracket": bracket_name,
                    "nominalRatePercent": round(nominal * 100, 2),
                    "deductionAmount": ded,
                    "effectiveRatePercent": effective_pct,
                    "city": city,
                    "explanation": f"Fórmula Simples Nacional Anexo I: [({rbt12:,.2f} × {nominal*100:.1f}%) - R$ {ded:,.2f}] ÷ {rbt12:,.2f} = {effective_pct}%"
                })
            else:
                iss_rate = 0.025 if "Florianópolis" in city else (0.03 if "Balneário" in city else 0.035)
                icms_rate = 0.12 if "SC" in city else 0.18
                total_presumido = round((0.0593 + iss_rate) * 100, 2)
                return self.send_json({
                    "success": True,
                    "regime": "LUCRO_PRESUMIDO",
                    "rbt12": rbt12,
                    "federalRatePercent": 5.93,
                    "issRatePercent": round(iss_rate * 100, 2),
                    "icmsRatePercent": round(icms_rate * 100, 2),
                    "effectiveRatePercent": total_presumido,
                    "city": city,
                    "explanation": f"Lucro Presumido: 5,93% Federal + {iss_rate*100:.1f}% ISS ({city}) = {total_presumido}% estimado"
                })

        # --- SALVAR ORÇAMENTO BASE ---
        elif path == "/api/erp/budget/save-base":
            budget_data = load_json("budget_scenarios.json")
            if "budgetVariance" in payload:
                budget_data["budgetVariance"] = payload["budgetVariance"]
            budget_data["lastUpdated"] = datetime.now().isoformat()
            save_json("budget_scenarios.json", budget_data)
            return self.send_json({"success": True, "message": "Orçamento base salvo com sucesso!"})

        else:
            return self.send_json({"error": "Rota não encontrada"}, 404)

def run_server():
    host = os.environ.get("HOST", "0.0.0.0")
    server_address = (host, PORT)
    httpd = HTTPServer(server_address, SieJoyHandler)
    print(f"===========================================================")
    print(f"SIÉ JOY OS - Web Management Server running on {host}:{PORT}")
    print(f"CRM & Growth Hub: http://localhost:{PORT}")
    if supabase_client and supabase_client.is_configured():
        print(f"Supabase: CONECTADO ({supabase_client.SUPABASE_URL})")
    else:
        print(f"Supabase: MODO LOCAL (JSON fallback - configure .env para ativar)")
    print(f"===========================================================")
    httpd.serve_forever()

if __name__ == "__main__":
    run_server()

