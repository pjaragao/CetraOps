
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "aff": {
          Tables: {
            "affiliates": {
                  Row: {
                    "commission_pct": number,"coupon_id": string,"created_at": string,"id": string,"notes": string | null,"org_id": string,"party_id": string,"payout_mode": string,"status": string,"student_discount_pct": number,"updated_at": string
                  }
                  Insert: {
                    "commission_pct"?: number,"coupon_id": string,"created_at"?: string,"id"?: string,"notes"?: string | null,"org_id": string,"party_id": string,"payout_mode"?: string,"status"?: string,"student_discount_pct"?: number,"updated_at"?: string
                  }
                  Update: {
                    "commission_pct"?: number,"coupon_id"?: string,"created_at"?: string,"id"?: string,"notes"?: string | null,"org_id"?: string,"party_id"?: string,"payout_mode"?: string,"status"?: string,"student_discount_pct"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"statements": {
                  Row: {
                    "affiliate_id": string,"approved_at": string | null,"approved_by": string | null,"commission": number,"commission_pct": number,"competence": string,"created_at": string,"detail": NonNullable<Json>,"id": string,"orders_count": number,"org_id": string,"paid_at": string | null,"payable_title_ids": (string)[],"payout_mode": string,"returns_amount": number,"sales_amount": number,"status": string,"updated_at": string
                  }
                  Insert: {
                    "affiliate_id": string,"approved_at"?: string | null,"approved_by"?: string | null,"commission"?: number,"commission_pct": number,"competence": string,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"orders_count"?: number,"org_id": string,"paid_at"?: string | null,"payable_title_ids"?: (string)[],"payout_mode": string,"returns_amount"?: number,"sales_amount"?: number,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "affiliate_id"?: string,"approved_at"?: string | null,"approved_by"?: string | null,"commission"?: number,"commission_pct"?: number,"competence"?: string,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"orders_count"?: number,"org_id"?: string,"paid_at"?: string | null,"payable_title_ids"?: (string)[],"payout_mode"?: string,"returns_amount"?: number,"sales_amount"?: number,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "statements_affiliate_id_fkey"
      columns: ["affiliate_id"]
isOneToOne: false
      referencedRelation: "affiliates"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "approve_statement":
{ Args: { "p_id": string }; Returns: {
              "affiliate_id": string,
"approved_at": string | null,
"approved_by": string | null,
"commission": number,
"commission_pct": number,
"competence": string,
"created_at": string,
"detail": NonNullable<Json>,
"id": string,
"orders_count": number,
"org_id": string,
"paid_at": string | null,
"payable_title_ids": (string)[],
"payout_mode": string,
"returns_amount": number,
"sales_amount": number,
"status": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "statements"
        isOneToOne: true
        isSetofReturn: false
      } },
"generate_statement":
{ Args: { "p_affiliate": string,"p_competence": string }; Returns: {
              "affiliate_id": string,
"approved_at": string | null,
"approved_by": string | null,
"commission": number,
"commission_pct": number,
"competence": string,
"created_at": string,
"detail": NonNullable<Json>,
"id": string,
"orders_count": number,
"org_id": string,
"paid_at": string | null,
"payable_title_ids": (string)[],
"payout_mode": string,
"returns_amount": number,
"sales_amount": number,
"status": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "statements"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_affiliate":
{ Args: { "p": Json }; Returns: {
              "commission_pct": number,
"coupon_id": string,
"created_at": string,
"id": string,
"notes": string | null,
"org_id": string,
"party_id": string,
"payout_mode": string,
"status": string,
"student_discount_pct": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "affiliates"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_affiliate_status":
{ Args: { "p_id": string,"p_status": string }; Returns: {
              "commission_pct": number,
"coupon_id": string,
"created_at": string,
"id": string,
"notes": string | null,
"org_id": string,
"party_id": string,
"payout_mode": string,
"status": string,
"student_discount_pct": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "affiliates"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"ai": {
          Tables: {
            "corpus_dialogues": {
                  Row: {
                    "classified_at": string | null,"commercial": boolean | null,"created_at": string,"digest": string,"id": string,"include": boolean,"org_id": string,"outcome": string | null,"persona_id": string,"source_id": string,"topics": (string)[],"turns": NonNullable<Json>
                  }
                  Insert: {
                    "classified_at"?: string | null,"commercial"?: boolean | null,"created_at"?: string,"digest": string,"id"?: string,"include"?: boolean,"org_id": string,"outcome"?: string | null,"persona_id": string,"source_id": string,"topics"?: (string)[],"turns": NonNullable<Json>
                  }
                  Update: {
                    "classified_at"?: string | null,"commercial"?: boolean | null,"created_at"?: string,"digest"?: string,"id"?: string,"include"?: boolean,"org_id"?: string,"outcome"?: string | null,"persona_id"?: string,"source_id"?: string,"topics"?: (string)[],"turns"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "corpus_dialogues_persona_id_fkey"
      columns: ["persona_id"]
isOneToOne: false
      referencedRelation: "personas"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "corpus_dialogues_source_id_fkey"
      columns: ["source_id"]
isOneToOne: false
      referencedRelation: "corpus_sources"
      referencedColumns: ["id"]
    }
                  ]
                },"corpus_pairs": {
                  Row: {
                    "context": NonNullable<Json>,"created_at": string,"dialogue_id": string | null,"embedding": unknown,"embedding_model": string | null,"id": string,"intent": string | null,"message_id": string | null,"org_id": string,"persona_id": string,"position": number | null,"reply": NonNullable<Json>,"source": string,"stage": string | null,"weight": number
                  }
                  Insert: {
                    "context": NonNullable<Json>,"created_at"?: string,"dialogue_id"?: string | null,"embedding"?: unknown,"embedding_model"?: string | null,"id"?: string,"intent"?: string | null,"message_id"?: string | null,"org_id": string,"persona_id": string,"position"?: number | null,"reply": NonNullable<Json>,"source": string,"stage"?: string | null,"weight"?: number
                  }
                  Update: {
                    "context"?: NonNullable<Json>,"created_at"?: string,"dialogue_id"?: string | null,"embedding"?: unknown,"embedding_model"?: string | null,"id"?: string,"intent"?: string | null,"message_id"?: string | null,"org_id"?: string,"persona_id"?: string,"position"?: number | null,"reply"?: NonNullable<Json>,"source"?: string,"stage"?: string | null,"weight"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "corpus_pairs_dialogue_id_fkey"
      columns: ["dialogue_id"]
isOneToOne: false
      referencedRelation: "corpus_dialogues"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "corpus_pairs_persona_id_fkey"
      columns: ["persona_id"]
isOneToOne: false
      referencedRelation: "personas"
      referencedColumns: ["id"]
    }
                  ]
                },"corpus_raw": {
                  Row: {
                    "content": string,"source_id": string
                  }
                  Insert: {
                    "content": string,"source_id": string
                  }
                  Update: {
                    "content"?: string,"source_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "corpus_raw_source_id_fkey"
      columns: ["source_id"]
isOneToOne: true
      referencedRelation: "corpus_sources"
      referencedColumns: ["id"]
    }
                  ]
                },"corpus_sources": {
                  Row: {
                    "bytes": number | null,"created_at": string,"created_by": string | null,"error": string | null,"filename": string | null,"id": string,"kind": string,"org_id": string,"owner_name": string,"persona_id": string,"processed_at": string | null,"raw_deleted_at": string | null,"stats": NonNullable<Json>,"status": string
                  }
                  Insert: {
                    "bytes"?: number | null,"created_at"?: string,"created_by"?: string | null,"error"?: string | null,"filename"?: string | null,"id"?: string,"kind": string,"org_id": string,"owner_name": string,"persona_id": string,"processed_at"?: string | null,"raw_deleted_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: string
                  }
                  Update: {
                    "bytes"?: number | null,"created_at"?: string,"created_by"?: string | null,"error"?: string | null,"filename"?: string | null,"id"?: string,"kind"?: string,"org_id"?: string,"owner_name"?: string,"persona_id"?: string,"processed_at"?: string | null,"raw_deleted_at"?: string | null,"stats"?: NonNullable<Json>,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "corpus_sources_persona_id_fkey"
      columns: ["persona_id"]
isOneToOne: false
      referencedRelation: "personas"
      referencedColumns: ["id"]
    }
                  ]
                },"customer_memories": {
                  Row: {
                    "category": string | null,"confidence": number | null,"created_at": string,"expires_at": string | null,"fact": string,"id": string,"org_id": string,"party_id": string,"source_message_id": string | null,"verified": boolean
                  }
                  Insert: {
                    "category"?: string | null,"confidence"?: number | null,"created_at"?: string,"expires_at"?: string | null,"fact": string,"id"?: string,"org_id": string,"party_id": string,"source_message_id"?: string | null,"verified"?: boolean
                  }
                  Update: {
                    "category"?: string | null,"confidence"?: number | null,"created_at"?: string,"expires_at"?: string | null,"fact"?: string,"id"?: string,"org_id"?: string,"party_id"?: string,"source_message_id"?: string | null,"verified"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"eval_batches": {
                  Row: {
                    "avg_latency_ms": number | null,"cases": number,"cost_usd": number,"created_at": string,"factual_failures": number,"handoff_misses": number,"id": string,"model": string,"org_id": string,"p95_latency_ms": number | null,"passed": number,"request_id": string | null,"route_task": string,"suite": string,"tokens_in": number,"tokens_out": number
                  }
                  Insert: {
                    "avg_latency_ms"?: number | null,"cases"?: number,"cost_usd"?: number,"created_at"?: string,"factual_failures"?: number,"handoff_misses"?: number,"id"?: string,"model": string,"org_id": string,"p95_latency_ms"?: number | null,"passed"?: number,"request_id"?: string | null,"route_task"?: string,"suite": string,"tokens_in"?: number,"tokens_out"?: number
                  }
                  Update: {
                    "avg_latency_ms"?: number | null,"cases"?: number,"cost_usd"?: number,"created_at"?: string,"factual_failures"?: number,"handoff_misses"?: number,"id"?: string,"model"?: string,"org_id"?: string,"p95_latency_ms"?: number | null,"passed"?: number,"request_id"?: string | null,"route_task"?: string,"suite"?: string,"tokens_in"?: number,"tokens_out"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_batches_request_id_fkey"
      columns: ["request_id"]
isOneToOne: false
      referencedRelation: "eval_requests"
      referencedColumns: ["id"]
    }
                  ]
                },"eval_cases": {
                  Row: {
                    "active": boolean,"created_at": string,"expect": NonNullable<Json>,"id": string,"key": string,"org_id": string,"suite": string,"title": string,"turns": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"expect"?: NonNullable<Json>,"id"?: string,"key": string,"org_id": string,"suite"?: string,"title": string,"turns": NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"expect"?: NonNullable<Json>,"id"?: string,"key"?: string,"org_id"?: string,"suite"?: string,"title"?: string,"turns"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"eval_requests": {
                  Row: {
                    "error": string | null,"finished_at": string | null,"id": string,"models": (string)[],"org_id": string,"progress": string | null,"requested_at": string,"requested_by": string | null,"status": string,"suite": string
                  }
                  Insert: {
                    "error"?: string | null,"finished_at"?: string | null,"id"?: string,"models": (string)[],"org_id": string,"progress"?: string | null,"requested_at"?: string,"requested_by"?: string | null,"status"?: string,"suite"?: string
                  }
                  Update: {
                    "error"?: string | null,"finished_at"?: string | null,"id"?: string,"models"?: (string)[],"org_id"?: string,"progress"?: string | null,"requested_at"?: string,"requested_by"?: string | null,"status"?: string,"suite"?: string
                  }
                  Relationships: [
                    
                  ]
                },"eval_results": {
                  Row: {
                    "batch_id": string,"case_id": string | null,"case_key": string,"cost_usd": number,"error": string | null,"failures": NonNullable<Json>,"flags": NonNullable<Json>,"id": string,"latency_ms": number | null,"org_id": string,"outcome": string | null,"passed": boolean,"replies": NonNullable<Json>,"tokens_in": number,"tokens_out": number,"tools": NonNullable<Json>
                  }
                  Insert: {
                    "batch_id": string,"case_id"?: string | null,"case_key": string,"cost_usd"?: number,"error"?: string | null,"failures"?: NonNullable<Json>,"flags"?: NonNullable<Json>,"id"?: string,"latency_ms"?: number | null,"org_id": string,"outcome"?: string | null,"passed": boolean,"replies"?: NonNullable<Json>,"tokens_in"?: number,"tokens_out"?: number,"tools"?: NonNullable<Json>
                  }
                  Update: {
                    "batch_id"?: string,"case_id"?: string | null,"case_key"?: string,"cost_usd"?: number,"error"?: string | null,"failures"?: NonNullable<Json>,"flags"?: NonNullable<Json>,"id"?: string,"latency_ms"?: number | null,"org_id"?: string,"outcome"?: string | null,"passed"?: boolean,"replies"?: NonNullable<Json>,"tokens_in"?: number,"tokens_out"?: number,"tools"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_results_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "eval_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eval_results_case_id_fkey"
      columns: ["case_id"]
isOneToOne: false
      referencedRelation: "eval_cases"
      referencedColumns: ["id"]
    }
                  ]
                },"knowledge_chunks": {
                  Row: {
                    "content": string,"doc_id": string,"id": string,"org_id": string,"position": number,"tsv": unknown
                  }
                  Insert: {
                    "content": string,"doc_id": string,"id"?: string,"org_id": string,"position": number,"tsv"?: unknown
                  }
                  Update: {
                    "content"?: string,"doc_id"?: string,"id"?: string,"org_id"?: string,"position"?: number,"tsv"?: unknown
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_chunks_doc_id_fkey"
      columns: ["doc_id"]
isOneToOne: false
      referencedRelation: "knowledge_docs"
      referencedColumns: ["id"]
    }
                  ]
                },"knowledge_docs": {
                  Row: {
                    "body_md": string | null,"created_at": string,"created_by": string | null,"draft_md": string,"id": string,"kind": string,"org_id": string,"published_at": string | null,"published_by": string | null,"status": string,"title": string,"updated_at": string,"valid_from": string | null,"valid_to": string | null,"version": number
                  }
                  Insert: {
                    "body_md"?: string | null,"created_at"?: string,"created_by"?: string | null,"draft_md"?: string,"id"?: string,"kind"?: string,"org_id": string,"published_at"?: string | null,"published_by"?: string | null,"status"?: string,"title": string,"updated_at"?: string,"valid_from"?: string | null,"valid_to"?: string | null,"version"?: number
                  }
                  Update: {
                    "body_md"?: string | null,"created_at"?: string,"created_by"?: string | null,"draft_md"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"published_at"?: string | null,"published_by"?: string | null,"status"?: string,"title"?: string,"updated_at"?: string,"valid_from"?: string | null,"valid_to"?: string | null,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"knowledge_versions": {
                  Row: {
                    "body_md": string,"doc_id": string,"id": string,"org_id": string,"published_at": string,"published_by": string | null,"title": string,"version": number
                  }
                  Insert: {
                    "body_md": string,"doc_id": string,"id"?: string,"org_id": string,"published_at"?: string,"published_by"?: string | null,"title": string,"version": number
                  }
                  Update: {
                    "body_md"?: string,"doc_id"?: string,"id"?: string,"org_id"?: string,"published_at"?: string,"published_by"?: string | null,"title"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_versions_doc_id_fkey"
      columns: ["doc_id"]
isOneToOne: false
      referencedRelation: "knowledge_docs"
      referencedColumns: ["id"]
    }
                  ]
                },"model_route_changes": {
                  Row: {
                    "after": NonNullable<Json>,"before": Json | null,"changed_at": string,"changed_by": string | null,"id": number,"org_id": string,"task": string
                  }
                  Insert: {
                    "after": NonNullable<Json>,"before"?: Json | null,"changed_at"?: string,"changed_by"?: string | null,"id"?: never,"org_id": string,"task": string
                  }
                  Update: {
                    "after"?: NonNullable<Json>,"before"?: Json | null,"changed_at"?: string,"changed_by"?: string | null,"id"?: never,"org_id"?: string,"task"?: string
                  }
                  Relationships: [
                    
                  ]
                },"model_routes": {
                  Row: {
                    "active": boolean,"daily_budget_usd": number | null,"fallback_models": (string)[],"id": string,"org_id": string,"params": NonNullable<Json>,"primary_model": string,"provider_prefs": NonNullable<Json>,"requires_json_schema": boolean,"requires_tools": boolean,"task": string,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "active"?: boolean,"daily_budget_usd"?: number | null,"fallback_models"?: (string)[],"id"?: string,"org_id": string,"params"?: NonNullable<Json>,"primary_model": string,"provider_prefs"?: NonNullable<Json>,"requires_json_schema"?: boolean,"requires_tools"?: boolean,"task": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"daily_budget_usd"?: number | null,"fallback_models"?: (string)[],"id"?: string,"org_id"?: string,"params"?: NonNullable<Json>,"primary_model"?: string,"provider_prefs"?: NonNullable<Json>,"requires_json_schema"?: boolean,"requires_tools"?: boolean,"task"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"persona_versions": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"created_at": string,"eval_score": Json | null,"guardrails": NonNullable<Json>,"id": string,"org_id": string,"persona_id": string,"style_profile": NonNullable<Json>,"system_prompt": string | null,"version": number
                  }
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"created_at"?: string,"eval_score"?: Json | null,"guardrails"?: NonNullable<Json>,"id"?: string,"org_id": string,"persona_id": string,"style_profile"?: NonNullable<Json>,"system_prompt"?: string | null,"version": number
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"created_at"?: string,"eval_score"?: Json | null,"guardrails"?: NonNullable<Json>,"id"?: string,"org_id"?: string,"persona_id"?: string,"style_profile"?: NonNullable<Json>,"system_prompt"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "persona_versions_persona_id_fkey"
      columns: ["persona_id"]
isOneToOne: false
      referencedRelation: "personas"
      referencedColumns: ["id"]
    }
                  ]
                },"personas": {
                  Row: {
                    "active_version_id": string | null,"created_at": string,"id": string,"member_id": string | null,"name": string,"org_id": string
                  }
                  Insert: {
                    "active_version_id"?: string | null,"created_at"?: string,"id"?: string,"member_id"?: string | null,"name": string,"org_id": string
                  }
                  Update: {
                    "active_version_id"?: string | null,"created_at"?: string,"id"?: string,"member_id"?: string | null,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "personas_active_version_fk"
      columns: ["active_version_id"]
isOneToOne: false
      referencedRelation: "persona_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"runs": {
                  Row: {
                    "cache_read_tokens": number | null,"confidence": number | null,"conversation_id": string | null,"cost_usd": number | null,"created_at": string,"error": string | null,"id": string,"latency_ms": number | null,"model": string | null,"org_id": string,"party_id": string | null,"persona_version_id": string | null,"provider": string | null,"route_task": string,"status": string,"tokens_in": number | null,"tokens_out": number | null,"trace_id": string | null
                  }
                  Insert: {
                    "cache_read_tokens"?: number | null,"confidence"?: number | null,"conversation_id"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"error"?: string | null,"id"?: string,"latency_ms"?: number | null,"model"?: string | null,"org_id": string,"party_id"?: string | null,"persona_version_id"?: string | null,"provider"?: string | null,"route_task": string,"status"?: string,"tokens_in"?: number | null,"tokens_out"?: number | null,"trace_id"?: string | null
                  }
                  Update: {
                    "cache_read_tokens"?: number | null,"confidence"?: number | null,"conversation_id"?: string | null,"cost_usd"?: number | null,"created_at"?: string,"error"?: string | null,"id"?: string,"latency_ms"?: number | null,"model"?: string | null,"org_id"?: string,"party_id"?: string | null,"persona_version_id"?: string | null,"provider"?: string | null,"route_task"?: string,"status"?: string,"tokens_in"?: number | null,"tokens_out"?: number | null,"trace_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "runs_persona_version_id_fkey"
      columns: ["persona_version_id"]
isOneToOne: false
      referencedRelation: "persona_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"suggestions": {
                  Row: {
                    "confidence": number | null,"created_at": string,"decided_at": string | null,"decided_by": string | null,"decision_note": string | null,"id": string,"kind": string,"org_id": string,"payload": NonNullable<Json>,"status": string,"target_id": string | null,"target_type": string | null
                  }
                  Insert: {
                    "confidence"?: number | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"kind": string,"org_id": string,"payload": NonNullable<Json>,"status"?: string,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Update: {
                    "confidence"?: number | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"decision_note"?: string | null,"id"?: string,"kind"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"status"?: string,"target_id"?: string | null,"target_type"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"tool_calls": {
                  Row: {
                    "args": NonNullable<Json>,"created_at": string,"id": number,"ms": number | null,"ok": boolean,"result_digest": Json | null,"run_id": string,"tool": string
                  }
                  Insert: {
                    "args"?: NonNullable<Json>,"created_at"?: string,"id"?: never,"ms"?: number | null,"ok": boolean,"result_digest"?: Json | null,"run_id": string,"tool": string
                  }
                  Update: {
                    "args"?: NonNullable<Json>,"created_at"?: string,"id"?: never,"ms"?: number | null,"ok"?: boolean,"result_digest"?: Json | null,"run_id"?: string,"tool"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tool_calls_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "approve_persona_version":
{ Args: { "p_id": string }; Returns: {
              "active_version_id": string | null,
"created_at": string,
"id": string,
"member_id": string | null,
"name": string,
"org_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "personas"
        isOneToOne: true
        isSetofReturn: false
      } },
"archive_knowledge_doc":
{ Args: { "p_archive"?: boolean,"p_id": string }; Returns: {
              "body_md": string | null,
"created_at": string,
"created_by": string | null,
"draft_md": string,
"id": string,
"kind": string,
"org_id": string,
"published_at": string | null,
"published_by": string | null,
"status": string,
"title": string,
"updated_at": string,
"valid_from": string | null,
"valid_to": string | null,
"version": number
            }
                          SetofOptions: {
        from: "*"
        to: "knowledge_docs"
        isOneToOne: true
        isSetofReturn: false
      } },
"corpus_add_live_pair":
{ Args: { "p": Json }; Returns: string
                           },
"corpus_embeddings":
{ Args: { "p": Json }; Returns: number
                           },
"corpus_fail":
{ Args: { "p_error": string,"p_source": string }; Returns: undefined
                           },
"corpus_ingest":
{ Args: { "p": Json }; Returns: Json
                           },
"corpus_labels":
{ Args: { "p": Json }; Returns: number
                           },
"corpus_mark_processing":
{ Args: { "p_source": string }; Returns: undefined
                           },
"create_corpus_source":
{ Args: { "p": Json }; Returns: {
              "bytes": number | null,
"created_at": string,
"created_by": string | null,
"error": string | null,
"filename": string | null,
"id": string,
"kind": string,
"org_id": string,
"owner_name": string,
"persona_id": string,
"processed_at": string | null,
"raw_deleted_at": string | null,
"stats": NonNullable<Json>,
"status": string
            }
                          SetofOptions: {
        from: "*"
        to: "corpus_sources"
        isOneToOne: true
        isSetofReturn: false
      } },
"decide_suggestion":
{ Args: { "p_id": string,"p_note"?: string,"p_status": string }; Returns: {
              "confidence": number | null,
"created_at": string,
"decided_at": string | null,
"decided_by": string | null,
"decision_note": string | null,
"id": string,
"kind": string,
"org_id": string,
"payload": NonNullable<Json>,
"status": string,
"target_id": string | null,
"target_type": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "suggestions"
        isOneToOne: true
        isSetofReturn: false
      } },
"delete_corpus_source":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_eval_case":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_knowledge_doc":
{ Args: { "p_id": string }; Returns: undefined
                           },
"eval_gate_check":
{ Args: { "p_model": string,"p_task": string }; Returns: Json
                           },
"eval_mark":
{ Args: { "p_error"?: string,"p_progress"?: string,"p_request": string,"p_status": string }; Returns: undefined
                           },
"eval_ranking":
{ Args: { "p_task"?: string }; Returns: Json
                           },
"eval_save_batch":
{ Args: { "p": Json,"p_org": string }; Returns: string
                           },
"knowledge_search":
{ Args: { "p_limit"?: number,"p_query": string }; Returns: Json
                           },
"persona_new_version":
{ Args: { "p": Json }; Returns: string
                           },
"publish_knowledge_doc":
{ Args: { "p_id": string }; Returns: {
              "body_md": string | null,
"created_at": string,
"created_by": string | null,
"draft_md": string,
"id": string,
"kind": string,
"org_id": string,
"published_at": string | null,
"published_by": string | null,
"status": string,
"title": string,
"updated_at": string,
"valid_from": string | null,
"valid_to": string | null,
"version": number
            }
                          SetofOptions: {
        from: "*"
        to: "knowledge_docs"
        isOneToOne: true
        isSetofReturn: false
      } },
"request_corpus_task":
{ Args: { "p_action": string,"p_persona": string }; Returns: undefined
                           },
"request_eval":
{ Args: { "p_models": (string)[] }; Returns: {
              "error": string | null,
"finished_at": string | null,
"id": string,
"models": (string)[],
"org_id": string,
"progress": string | null,
"requested_at": string,
"requested_by": string | null,
"status": string,
"suite": string
            }
                          SetofOptions: {
        from: "*"
        to: "eval_requests"
        isOneToOne: true
        isSetofReturn: false
      } },
"request_persona_profile":
{ Args: { "p_lexicon"?: (string)[],"p_persona": string }; Returns: undefined
                           },
"run_detectors":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"save_conversation_summary":
{ Args: { "p": Json,"p_conversation": string }; Returns: undefined
                           },
"save_eval_case":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"created_at": string,
"expect": NonNullable<Json>,
"id": string,
"key": string,
"org_id": string,
"suite": string,
"title": string,
"turns": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "eval_cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_knowledge_doc":
{ Args: { "p_body": string,"p_id": string,"p_kind": string,"p_title": string,"p_valid_from"?: string,"p_valid_to"?: string }; Returns: {
              "body_md": string | null,
"created_at": string,
"created_by": string | null,
"draft_md": string,
"id": string,
"kind": string,
"org_id": string,
"published_at": string | null,
"published_by": string | null,
"status": string,
"title": string,
"updated_at": string,
"valid_from": string | null,
"valid_to": string | null,
"version": number
            }
                          SetofOptions: {
        from: "*"
        to: "knowledge_docs"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_persona":
{ Args: { "p": Json }; Returns: {
              "active_version_id": string | null,
"created_at": string,
"id": string,
"member_id": string | null,
"name": string,
"org_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "personas"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_persona_version":
{ Args: { "p": Json }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"created_at": string,
"eval_score": Json | null,
"guardrails": NonNullable<Json>,
"id": string,
"org_id": string,
"persona_id": string,
"style_profile": NonNullable<Json>,
"system_prompt": string | null,
"version": number
            }
                          SetofOptions: {
        from: "*"
        to: "persona_versions"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_dialogues_included":
{ Args: { "p_ids": (string)[],"p_include": boolean }; Returns: number
                           },
"similar_pairs":
{ Args: { "p_embedding": string,"p_k"?: number,"p_persona": string,"p_stage"?: string }; Returns: {
              "context": Json,"distance": number,"embedding": (number)[],"id": string,"intent": string,"reply": Json,"source": string,"stage": string,"weight": number
            }[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"catalog": {
          Tables: {
            "brands": {
                  Row: {
                    "id": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "id"?: string,"name": string,"org_id": string
                  }
                  Update: {
                    "id"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"categories": {
                  Row: {
                    "id": string,"name": string,"ncm_default": string | null,"org_id": string,"parent_id": string | null
                  }
                  Insert: {
                    "id"?: string,"name": string,"ncm_default"?: string | null,"org_id": string,"parent_id"?: string | null
                  }
                  Update: {
                    "id"?: string,"name"?: string,"ncm_default"?: string | null,"org_id"?: string,"parent_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    }
                  ]
                },"collections": {
                  Row: {
                    "created_at": string,"event_id": string | null,"id": string,"kind": string,"launch_date": string | null,"name": string,"org_id": string
                  }
                  Insert: {
                    "created_at"?: string,"event_id"?: string | null,"id"?: string,"kind": string,"launch_date"?: string | null,"name": string,"org_id": string
                  }
                  Update: {
                    "created_at"?: string,"event_id"?: string | null,"id"?: string,"kind"?: string,"launch_date"?: string | null,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"colors": {
                  Row: {
                    "code": string | null,"hex": string | null,"id": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "code"?: string | null,"hex"?: string | null,"id"?: string,"name": string,"org_id": string
                  }
                  Update: {
                    "code"?: string | null,"hex"?: string | null,"id"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"price_lists": {
                  Row: {
                    "id": string,"is_default": boolean,"kind": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "id"?: string,"is_default"?: boolean,"kind": string,"name": string,"org_id": string
                  }
                  Update: {
                    "id"?: string,"is_default"?: boolean,"kind"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"prices": {
                  Row: {
                    "id": string,"org_id": string,"price": number,"price_list_id": string,"product_id": string | null,"valid_from": string,"valid_to": string | null,"variant_id": string | null
                  }
                  Insert: {
                    "id"?: string,"org_id": string,"price": number,"price_list_id": string,"product_id"?: string | null,"valid_from"?: string,"valid_to"?: string | null,"variant_id"?: string | null
                  }
                  Update: {
                    "id"?: string,"org_id"?: string,"price"?: number,"price_list_id"?: string,"product_id"?: string | null,"valid_from"?: string,"valid_to"?: string | null,"variant_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "prices_price_list_id_fkey"
      columns: ["price_list_id"]
isOneToOne: false
      referencedRelation: "price_lists"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prices_product_id_fkey"
      columns: ["product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "prices_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "variants"
      referencedColumns: ["id"]
    }
                  ]
                },"product_media": {
                  Row: {
                    "color_id": string | null,"id": string,"org_id": string,"position": number,"product_id": string,"storage_path": string
                  }
                  Insert: {
                    "color_id"?: string | null,"id"?: string,"org_id": string,"position"?: number,"product_id": string,"storage_path": string
                  }
                  Update: {
                    "color_id"?: string | null,"id"?: string,"org_id"?: string,"position"?: number,"product_id"?: string,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "product_media_color_id_fkey"
      columns: ["color_id"]
isOneToOne: false
      referencedRelation: "colors"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "product_media_product_id_fkey"
      columns: ["product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id"]
    }
                  ]
                },"products": {
                  Row: {
                    "activities": (string)[],"assortment_class": Database["catalog"]['Enums']["assortment_class"],"brand_id": string | null,"care": string | null,"category_id": string | null,"cest": string | null,"collection_id": string | null,"composition": string | null,"created_at": string,"custom_fields": NonNullable<Json>,"description": string | null,"gender": Database["catalog"]['Enums']["gender"],"id": string,"name": string,"ncm": string | null,"org_id": string,"origin": number,"product_kind": Database["catalog"]['Enums']["product_kind"],"reference_code": string,"size_chart_id": string | null,"size_grid_id": string | null,"status": Database["catalog"]['Enums']["product_status"],"updated_at": string
                  }
                  Insert: {
                    "activities"?: (string)[],"assortment_class"?: Database["catalog"]['Enums']["assortment_class"],"brand_id"?: string | null,"care"?: string | null,"category_id"?: string | null,"cest"?: string | null,"collection_id"?: string | null,"composition"?: string | null,"created_at"?: string,"custom_fields"?: NonNullable<Json>,"description"?: string | null,"gender": Database["catalog"]['Enums']["gender"],"id"?: string,"name": string,"ncm"?: string | null,"org_id": string,"origin"?: number,"product_kind"?: Database["catalog"]['Enums']["product_kind"],"reference_code": string,"size_chart_id"?: string | null,"size_grid_id"?: string | null,"status"?: Database["catalog"]['Enums']["product_status"],"updated_at"?: string
                  }
                  Update: {
                    "activities"?: (string)[],"assortment_class"?: Database["catalog"]['Enums']["assortment_class"],"brand_id"?: string | null,"care"?: string | null,"category_id"?: string | null,"cest"?: string | null,"collection_id"?: string | null,"composition"?: string | null,"created_at"?: string,"custom_fields"?: NonNullable<Json>,"description"?: string | null,"gender"?: Database["catalog"]['Enums']["gender"],"id"?: string,"name"?: string,"ncm"?: string | null,"org_id"?: string,"origin"?: number,"product_kind"?: Database["catalog"]['Enums']["product_kind"],"reference_code"?: string,"size_chart_id"?: string | null,"size_grid_id"?: string | null,"status"?: Database["catalog"]['Enums']["product_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "products_brand_id_fkey"
      columns: ["brand_id"]
isOneToOne: false
      referencedRelation: "brands"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_collection_id_fkey"
      columns: ["collection_id"]
isOneToOne: false
      referencedRelation: "collections"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_size_chart_id_fkey"
      columns: ["size_chart_id"]
isOneToOne: false
      referencedRelation: "size_charts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "products_size_grid_id_fkey"
      columns: ["size_grid_id"]
isOneToOne: false
      referencedRelation: "size_grids"
      referencedColumns: ["id"]
    }
                  ]
                },"size_charts": {
                  Row: {
                    "id": string,"measurements": NonNullable<Json>,"name": string,"org_id": string
                  }
                  Insert: {
                    "id"?: string,"measurements"?: NonNullable<Json>,"name": string,"org_id": string
                  }
                  Update: {
                    "id"?: string,"measurements"?: NonNullable<Json>,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"size_grids": {
                  Row: {
                    "id": string,"name": string,"org_id": string,"sizes": (string)[]
                  }
                  Insert: {
                    "id"?: string,"name": string,"org_id": string,"sizes": (string)[]
                  }
                  Update: {
                    "id"?: string,"name"?: string,"org_id"?: string,"sizes"?: (string)[]
                  }
                  Relationships: [
                    
                  ]
                },"supplier_items": {
                  Row: {
                    "confidence": number | null,"confirmed_by": string | null,"created_at": string,"factor": number,"id": string,"org_id": string,"supplier_cprod": string,"supplier_desc": string | null,"supplier_ean": string | null,"supplier_party_id": string,"variant_id": string
                  }
                  Insert: {
                    "confidence"?: number | null,"confirmed_by"?: string | null,"created_at"?: string,"factor"?: number,"id"?: string,"org_id": string,"supplier_cprod": string,"supplier_desc"?: string | null,"supplier_ean"?: string | null,"supplier_party_id": string,"variant_id": string
                  }
                  Update: {
                    "confidence"?: number | null,"confirmed_by"?: string | null,"created_at"?: string,"factor"?: number,"id"?: string,"org_id"?: string,"supplier_cprod"?: string,"supplier_desc"?: string | null,"supplier_ean"?: string | null,"supplier_party_id"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "supplier_items_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "variants"
      referencedColumns: ["id"]
    }
                  ]
                },"variants": {
                  Row: {
                    "active": boolean,"color_id": string | null,"created_at": string,"gtin": string | null,"id": string,"org_id": string,"product_id": string,"size": string,"sku": string,"supplier_sku": string | null,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"color_id"?: string | null,"created_at"?: string,"gtin"?: string | null,"id"?: string,"org_id": string,"product_id": string,"size": string,"sku": string,"supplier_sku"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"color_id"?: string | null,"created_at"?: string,"gtin"?: string | null,"id"?: string,"org_id"?: string,"product_id"?: string,"size"?: string,"sku"?: string,"supplier_sku"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "variants_color_id_fkey"
      columns: ["color_id"]
isOneToOne: false
      referencedRelation: "colors"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "variants_product_id_fkey"
      columns: ["product_id"]
isOneToOne: false
      referencedRelation: "products"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "current_price":
{ Args: { "p_price_list"?: string,"p_variant": string }; Returns: number
                           },
"import_rows":
{ Args: { "p": Json }; Returns: Json
                           }
          }
          Enums: {
            "assortment_class": "CORE"|"DROP"|"ACCESSORY","gender": "FEM"|"MASC"|"UNISSEX","product_kind": "GOODS"|"SERVICE"|"GIFT_WRAP"|"FEE","product_status": "DRAFT"|"ACTIVE"|"DISCONTINUED"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"comm": {
          Tables: {
            "statements": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"base_amount": number,"bonus": number,"commission": number,"competence": string,"created_at": string,"detail": NonNullable<Json>,"id": string,"member_id": string,"org_id": string,"payslip_id": string | null,"sales_amount": number,"status": string,"store_id": string | null,"total": number,"updated_at": string
                  }
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"base_amount"?: number,"bonus"?: number,"commission"?: number,"competence": string,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"member_id": string,"org_id": string,"payslip_id"?: string | null,"sales_amount"?: number,"status"?: string,"store_id"?: string | null,"total"?: number,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"base_amount"?: number,"bonus"?: number,"commission"?: number,"competence"?: string,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"member_id"?: string,"org_id"?: string,"payslip_id"?: string | null,"sales_amount"?: number,"status"?: string,"store_id"?: string | null,"total"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "approve_statement":
{ Args: { "p_statement": string }; Returns: undefined
                           },
"generate_statement":
{ Args: { "p_competence": string,"p_member": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"base_amount": number,
"bonus": number,
"commission": number,
"competence": string,
"created_at": string,
"detail": NonNullable<Json>,
"id": string,
"member_id": string,
"org_id": string,
"payslip_id": string | null,
"sales_amount": number,
"status": string,
"store_id": string | null,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "statements"
        isOneToOne: true
        isSetofReturn: false
      } },
"reopen_statement":
{ Args: { "p_statement": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"core": {
          Tables: {
            "attachments": {
                  Row: {
                    "created_at": string,"created_by": string | null,"entity_id": string,"entity_type": string,"id": string,"mime": string | null,"org_id": string,"sha256": string | null,"storage_path": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"entity_id": string,"entity_type": string,"id"?: string,"mime"?: string | null,"org_id": string,"sha256"?: string | null,"storage_path": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"entity_id"?: string,"entity_type"?: string,"id"?: string,"mime"?: string | null,"org_id"?: string,"sha256"?: string | null,"storage_path"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "attachments_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "attachments_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"cost_centers": {
                  Row: {
                    "archived_at": string | null,"channel": string | null,"code": string,"created_at": string,"id": string,"kind": Database["core"]['Enums']["cost_center_kind"],"legal_entity_id": string | null,"name": string,"org_id": string,"parent_id": string | null,"store_id": string | null,"updated_at": string,"valid_from": string,"valid_to": string | null
                  }
                  Insert: {
                    "archived_at"?: string | null,"channel"?: string | null,"code": string,"created_at"?: string,"id"?: string,"kind": Database["core"]['Enums']["cost_center_kind"],"legal_entity_id"?: string | null,"name": string,"org_id": string,"parent_id"?: string | null,"store_id"?: string | null,"updated_at"?: string,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Update: {
                    "archived_at"?: string | null,"channel"?: string | null,"code"?: string,"created_at"?: string,"id"?: string,"kind"?: Database["core"]['Enums']["cost_center_kind"],"legal_entity_id"?: string | null,"name"?: string,"org_id"?: string,"parent_id"?: string | null,"store_id"?: string | null,"updated_at"?: string,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "cost_centers_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_centers_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_centers_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "cost_centers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_centers_store_fk"
      columns: ["store_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id"]
    }
                  ]
                },"custom_field_defs": {
                  Row: {
                    "active": boolean,"entity_type": string,"id": string,"key": string,"label": string,"options": NonNullable<Json>,"org_id": string,"position": number,"required": boolean,"type": string
                  }
                  Insert: {
                    "active"?: boolean,"entity_type": string,"id"?: string,"key": string,"label": string,"options"?: NonNullable<Json>,"org_id": string,"position"?: number,"required"?: boolean,"type": string
                  }
                  Update: {
                    "active"?: boolean,"entity_type"?: string,"id"?: string,"key"?: string,"label"?: string,"options"?: NonNullable<Json>,"org_id"?: string,"position"?: number,"required"?: boolean,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "custom_field_defs_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"document_sequences": {
                  Row: {
                    "doc_type": string,"last_value": number,"org_id": string,"year": number
                  }
                  Insert: {
                    "doc_type": string,"last_value"?: number,"org_id": string,"year": number
                  }
                  Update: {
                    "doc_type"?: string,"last_value"?: number,"org_id"?: string,"year"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_sequences_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"feature_flags": {
                  Row: {
                    "enabled": boolean,"key": string,"org_id": string,"scope": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "enabled"?: boolean,"key": string,"org_id": string,"scope"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "enabled"?: boolean,"key"?: string,"org_id"?: string,"scope"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "feature_flags_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"integration_connections": {
                  Row: {
                    "capability": string,"config": NonNullable<Json>,"created_at": string,"id": string,"last_error": string | null,"last_sync_at": string | null,"legal_entity_id": string | null,"org_id": string,"provider": string,"secret_ref": string | null,"status": string,"updated_at": string
                  }
                  Insert: {
                    "capability": string,"config"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"last_error"?: string | null,"last_sync_at"?: string | null,"legal_entity_id"?: string | null,"org_id": string,"provider": string,"secret_ref"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "capability"?: string,"config"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"last_error"?: string | null,"last_sync_at"?: string | null,"legal_entity_id"?: string | null,"org_id"?: string,"provider"?: string,"secret_ref"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_connections_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "integration_connections_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"legacy_id_map": {
                  Row: {
                    "entity": string,"legacy_id": string,"new_id": string,"org_id": string
                  }
                  Insert: {
                    "entity": string,"legacy_id": string,"new_id": string,"org_id": string
                  }
                  Update: {
                    "entity"?: string,"legacy_id"?: string,"new_id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "legacy_id_map_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"legal_entities": {
                  Row: {
                    "address": NonNullable<Json>,"cert_expires_at": string | null,"cnae_principal": string | null,"cnaes_secundarios": (string)[],"cnpj": string,"created_at": string,"crt": number,"fiscal_provider_ref": string | null,"id": string,"ie": string | null,"im": string | null,"kind": Database["core"]['Enums']["legal_entity_kind"],"nfce_series": number | null,"nfe_series": number | null,"nome_fantasia": string | null,"org_id": string,"parent_id": string | null,"razao_social": string,"status": string,"tax_regime": string,"updated_at": string
                  }
                  Insert: {
                    "address"?: NonNullable<Json>,"cert_expires_at"?: string | null,"cnae_principal"?: string | null,"cnaes_secundarios"?: (string)[],"cnpj": string,"created_at"?: string,"crt"?: number,"fiscal_provider_ref"?: string | null,"id"?: string,"ie"?: string | null,"im"?: string | null,"kind"?: Database["core"]['Enums']["legal_entity_kind"],"nfce_series"?: number | null,"nfe_series"?: number | null,"nome_fantasia"?: string | null,"org_id": string,"parent_id"?: string | null,"razao_social": string,"status"?: string,"tax_regime"?: string,"updated_at"?: string
                  }
                  Update: {
                    "address"?: NonNullable<Json>,"cert_expires_at"?: string | null,"cnae_principal"?: string | null,"cnaes_secundarios"?: (string)[],"cnpj"?: string,"created_at"?: string,"crt"?: number,"fiscal_provider_ref"?: string | null,"id"?: string,"ie"?: string | null,"im"?: string | null,"kind"?: Database["core"]['Enums']["legal_entity_kind"],"nfce_series"?: number | null,"nfe_series"?: number | null,"nome_fantasia"?: string | null,"org_id"?: string,"parent_id"?: string | null,"razao_social"?: string,"status"?: string,"tax_regime"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "legal_entities_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "legal_entities_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    }
                  ]
                },"member_roles": {
                  Row: {
                    "member_id": string,"role_id": string
                  }
                  Insert: {
                    "member_id": string,"role_id": string
                  }
                  Update: {
                    "member_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "member_roles_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "member_roles_role_id_fkey"
      columns: ["role_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id"]
    }
                  ]
                },"member_store_access": {
                  Row: {
                    "all_stores": boolean,"id": string,"member_id": string,"store_id": string | null
                  }
                  Insert: {
                    "all_stores"?: boolean,"id"?: string,"member_id": string,"store_id"?: string | null
                  }
                  Update: {
                    "all_stores"?: boolean,"id"?: string,"member_id"?: string,"store_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "member_store_access_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "member_store_access_store_id_fkey"
      columns: ["store_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id"]
    }
                  ]
                },"members": {
                  Row: {
                    "created_at": string,"default_store_id": string | null,"display_name": string,"id": string,"must_change_password": boolean,"org_id": string,"party_id": string | null,"pin_hash": string | null,"status": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"default_store_id"?: string | null,"display_name": string,"id"?: string,"must_change_password"?: boolean,"org_id": string,"party_id"?: string | null,"pin_hash"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"default_store_id"?: string | null,"display_name"?: string,"id"?: string,"must_change_password"?: boolean,"org_id"?: string,"party_id"?: string | null,"pin_hash"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "members_default_store_id_fkey"
      columns: ["default_store_id"]
isOneToOne: false
      referencedRelation: "stores"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "members_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"member_id": string,"org_id": string,"payload": NonNullable<Json>,"read_at": string | null,"title": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"kind": string,"member_id": string,"org_id": string,"payload"?: NonNullable<Json>,"read_at"?: string | null,"title": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"member_id"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"read_at"?: string | null,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_member_id_fkey"
      columns: ["member_id"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"orgs": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"settings": NonNullable<Json>,"slug": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"settings"?: NonNullable<Json>,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"settings"?: NonNullable<Json>,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"permission_catalog": {
                  Row: {
                    "area": string,"description": string,"key": string,"label": string,"position": number
                  }
                  Insert: {
                    "area": string,"description": string,"key": string,"label": string,"position"?: number
                  }
                  Update: {
                    "area"?: string,"description"?: string,"key"?: string,"label"?: string,"position"?: number
                  }
                  Relationships: [
                    
                  ]
                },"role_permissions": {
                  Row: {
                    "permission_key": string,"role_id": string
                  }
                  Insert: {
                    "permission_key": string,"role_id": string
                  }
                  Update: {
                    "permission_key"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_permissions_role_id_fkey"
      columns: ["role_id"]
isOneToOne: false
      referencedRelation: "roles"
      referencedColumns: ["id"]
    }
                  ]
                },"roles": {
                  Row: {
                    "id": string,"is_superuser": boolean,"key": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "id"?: string,"is_superuser"?: boolean,"key": string,"name": string,"org_id": string
                  }
                  Update: {
                    "id"?: string,"is_superuser"?: boolean,"key"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roles_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"settings": {
                  Row: {
                    "key": string,"org_id": string,"updated_at": string,"value": NonNullable<Json>
                  }
                  Insert: {
                    "key": string,"org_id": string,"updated_at"?: string,"value": NonNullable<Json>
                  }
                  Update: {
                    "key"?: string,"org_id"?: string,"updated_at"?: string,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "settings_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                },"stores": {
                  Row: {
                    "area_m2": number | null,"business_hours": NonNullable<Json>,"closed_at": string | null,"code": string,"cost_center_id": string | null,"created_at": string,"fiscal_mode": string,"format": Database["core"]['Enums']["store_format"],"host_partner_party_id": string | null,"id": string,"legal_entity_id": string,"name": string,"opened_at": string | null,"org_id": string,"status": Database["core"]['Enums']["store_status"],"updated_at": string
                  }
                  Insert: {
                    "area_m2"?: number | null,"business_hours"?: NonNullable<Json>,"closed_at"?: string | null,"code": string,"cost_center_id"?: string | null,"created_at"?: string,"fiscal_mode"?: string,"format": Database["core"]['Enums']["store_format"],"host_partner_party_id"?: string | null,"id"?: string,"legal_entity_id": string,"name": string,"opened_at"?: string | null,"org_id": string,"status"?: Database["core"]['Enums']["store_status"],"updated_at"?: string
                  }
                  Update: {
                    "area_m2"?: number | null,"business_hours"?: NonNullable<Json>,"closed_at"?: string | null,"code"?: string,"cost_center_id"?: string | null,"created_at"?: string,"fiscal_mode"?: string,"format"?: Database["core"]['Enums']["store_format"],"host_partner_party_id"?: string | null,"id"?: string,"legal_entity_id"?: string,"name"?: string,"opened_at"?: string | null,"org_id"?: string,"status"?: Database["core"]['Enums']["store_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stores_cost_center_id_fkey"
      columns: ["cost_center_id"]
isOneToOne: false
      referencedRelation: "cost_centers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stores_legal_entity_id_fkey"
      columns: ["legal_entity_id"]
isOneToOne: false
      referencedRelation: "legal_entities"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stores_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "orgs"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "admin_users":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"cc_subtree":
{ Args: { "p_root": string }; Returns: (string)[]
                           },
"change_my_password":
{ Args: { "p_current": string,"p_new": string }; Returns: undefined
                           },
"create_user":
{ Args: { "p": Json }; Returns: string
                           },
"delete_role":
{ Args: { "p_id": string }; Returns: undefined
                           },
"integration_secret":
{ Args: { "p_connection": string }; Returns: Json
                           },
"next_number":
{ Args: { "p_doc_type": string,"p_org": string }; Returns: string
                           },
"notify":
{ Args: { "p_kind": string,"p_member"?: string,"p_org": string,"p_payload"?: Json,"p_perm"?: string,"p_title": string }; Returns: number
                           },
"party_access":
{ Args: { "p_party": string }; Returns: Json
                           },
"record_integration_health":
{ Args: { "p_detail"?: Json,"p_error"?: string,"p_id": string,"p_ok": boolean }; Returns: undefined
                           },
"remove_integration_secret":
{ Args: { "p_id": string }; Returns: undefined
                           },
"request_integration_check":
{ Args: { "p_action"?: string,"p_id": string }; Returns: undefined
                           },
"reset_user_password":
{ Args: { "p_member": string,"p_password": string }; Returns: undefined
                           },
"save_integration":
{ Args: { "p": Json }; Returns: Json
                           },
"save_role":
{ Args: { "p": Json }; Returns: {
              "id": string,
"is_superuser": boolean,
"key": string,
"name": string,
"org_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "roles"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_integration_enabled":
{ Args: { "p_enabled": boolean,"p_id": string }; Returns: undefined
                           },
"set_user_status":
{ Args: { "p_active": boolean,"p_member": string }; Returns: undefined
                           },
"update_user":
{ Args: { "p": Json,"p_member": string }; Returns: undefined
                           }
          }
          Enums: {
            "cost_center_kind": "CORPORATE"|"LEGAL_ENTITY"|"STORE"|"CHANNEL"|"PROJECT_EVENT"|"POOL","legal_entity_kind": "OPERATING"|"HOLDING","store_format": "SHOP_IN_SHOP"|"CONSIGNMENT_CORNER"|"POPUP"|"DIGITAL"|"WAREHOUSE"|"B2B","store_status": "PLANNED"|"ACTIVE"|"CLOSED"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"crm": {
          Tables: {
            "cases": {
                  Row: {
                    "conversation_id": string | null,"courtesy_amount": number,"courtesy_ledger_id": number | null,"description": string | null,"first_response_at": string | null,"first_response_due": string,"followup_task_id": string | null,"id": string,"kind": string,"late_alerted": boolean,"number": string,"opened_at": string,"opened_by": string | null,"org_id": string,"owner_member_id": string | null,"party_id": string,"resolve_due": string,"resolved_at": string | null,"solution": string | null,"source": string,"source_ref": string | null,"status": string,"title": string
                  }
                  Insert: {
                    "conversation_id"?: string | null,"courtesy_amount"?: number,"courtesy_ledger_id"?: number | null,"description"?: string | null,"first_response_at"?: string | null,"first_response_due": string,"followup_task_id"?: string | null,"id"?: string,"kind": string,"late_alerted"?: boolean,"number": string,"opened_at"?: string,"opened_by"?: string | null,"org_id": string,"owner_member_id"?: string | null,"party_id": string,"resolve_due": string,"resolved_at"?: string | null,"solution"?: string | null,"source"?: string,"source_ref"?: string | null,"status"?: string,"title": string
                  }
                  Update: {
                    "conversation_id"?: string | null,"courtesy_amount"?: number,"courtesy_ledger_id"?: number | null,"description"?: string | null,"first_response_at"?: string | null,"first_response_due"?: string,"followup_task_id"?: string | null,"id"?: string,"kind"?: string,"late_alerted"?: boolean,"number"?: string,"opened_at"?: string,"opened_by"?: string | null,"org_id"?: string,"owner_member_id"?: string | null,"party_id"?: string,"resolve_due"?: string,"resolved_at"?: string | null,"solution"?: string | null,"source"?: string,"source_ref"?: string | null,"status"?: string,"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cases_followup_task_id_fkey"
      columns: ["followup_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cases_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"consents": {
                  Row: {
                    "created_at": string,"evidence": NonNullable<Json>,"granted": boolean,"id": string,"legal_basis": Database["crm"]['Enums']["legal_basis"],"org_id": string,"party_id": string,"purpose": Database["crm"]['Enums']["consent_purpose"],"recorded_by": string | null
                  }
                  Insert: {
                    "created_at"?: string,"evidence"?: NonNullable<Json>,"granted": boolean,"id"?: string,"legal_basis": Database["crm"]['Enums']["legal_basis"],"org_id": string,"party_id": string,"purpose": Database["crm"]['Enums']["consent_purpose"],"recorded_by"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"evidence"?: NonNullable<Json>,"granted"?: boolean,"id"?: string,"legal_basis"?: Database["crm"]['Enums']["legal_basis"],"org_id"?: string,"party_id"?: string,"purpose"?: Database["crm"]['Enums']["consent_purpose"],"recorded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "consents_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"customer_metrics": {
                  Row: {
                    "at_risk": boolean,"at_risk_since": string | null,"avg_interval_days": number | null,"days_since_last": number | null,"first_purchase_at": string | null,"last_purchase_at": string | null,"orders_12m": number,"orders_total": number,"org_id": string,"party_id": string,"revenue_12m": number,"revenue_total": number,"rfm_segment": string,"updated_at": string
                  }
                  Insert: {
                    "at_risk"?: boolean,"at_risk_since"?: string | null,"avg_interval_days"?: number | null,"days_since_last"?: number | null,"first_purchase_at"?: string | null,"last_purchase_at"?: string | null,"orders_12m"?: number,"orders_total"?: number,"org_id": string,"party_id": string,"revenue_12m"?: number,"revenue_total"?: number,"rfm_segment"?: string,"updated_at"?: string
                  }
                  Update: {
                    "at_risk"?: boolean,"at_risk_since"?: string | null,"avg_interval_days"?: number | null,"days_since_last"?: number | null,"first_purchase_at"?: string | null,"last_purchase_at"?: string | null,"orders_12m"?: number,"orders_total"?: number,"org_id"?: string,"party_id"?: string,"revenue_12m"?: number,"revenue_total"?: number,"rfm_segment"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customer_metrics_party_id_fkey"
      columns: ["party_id"]
isOneToOne: true
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"deal_stage_history": {
                  Row: {
                    "changed_at": string,"changed_by": string | null,"deal_id": string,"from_stage_id": string | null,"id": number,"org_id": string,"to_stage_id": string
                  }
                  Insert: {
                    "changed_at"?: string,"changed_by"?: string | null,"deal_id": string,"from_stage_id"?: string | null,"id"?: never,"org_id": string,"to_stage_id": string
                  }
                  Update: {
                    "changed_at"?: string,"changed_by"?: string | null,"deal_id"?: string,"from_stage_id"?: string | null,"id"?: never,"org_id"?: string,"to_stage_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "deal_stage_history_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deal_stage_history_from_stage_id_fkey"
      columns: ["from_stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deal_stage_history_to_stage_id_fkey"
      columns: ["to_stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    }
                  ]
                },"deals": {
                  Row: {
                    "conversation_id": string | null,"created_at": string,"id": string,"lost_reason": string | null,"org_id": string,"owner_member_id": string | null,"party_id": string,"pipeline_id": string,"stage_id": string,"status": string,"title": string,"updated_at": string,"value_estimated": number | null,"won_order_id": string | null
                  }
                  Insert: {
                    "conversation_id"?: string | null,"created_at"?: string,"id"?: string,"lost_reason"?: string | null,"org_id": string,"owner_member_id"?: string | null,"party_id": string,"pipeline_id": string,"stage_id": string,"status"?: string,"title": string,"updated_at"?: string,"value_estimated"?: number | null,"won_order_id"?: string | null
                  }
                  Update: {
                    "conversation_id"?: string | null,"created_at"?: string,"id"?: string,"lost_reason"?: string | null,"org_id"?: string,"owner_member_id"?: string | null,"party_id"?: string,"pipeline_id"?: string,"stage_id"?: string,"status"?: string,"title"?: string,"updated_at"?: string,"value_estimated"?: number | null,"won_order_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "deals_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_pipeline_id_fkey"
      columns: ["pipeline_id"]
isOneToOne: false
      referencedRelation: "pipelines"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "deals_stage_id_fkey"
      columns: ["stage_id"]
isOneToOne: false
      referencedRelation: "pipeline_stages"
      referencedColumns: ["id"]
    }
                  ]
                },"interest_alerts": {
                  Row: {
                    "color_id": string | null,"created_at": string,"created_by": string | null,"created_via": string,"id": string,"note": string | null,"notified_at": string | null,"org_id": string,"party_id": string,"product_id": string,"reservation_id": string | null,"size": string,"status": string
                  }
                  Insert: {
                    "color_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"created_via"?: string,"id"?: string,"note"?: string | null,"notified_at"?: string | null,"org_id": string,"party_id": string,"product_id": string,"reservation_id"?: string | null,"size": string,"status"?: string
                  }
                  Update: {
                    "color_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"created_via"?: string,"id"?: string,"note"?: string | null,"notified_at"?: string | null,"org_id"?: string,"party_id"?: string,"product_id"?: string,"reservation_id"?: string | null,"size"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "interest_alerts_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"lead_scoring_rules": {
                  Row: {
                    "active": boolean,"created_at": string,"id": string,"org_id": string,"rules": NonNullable<Json>,"version": number
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"org_id": string,"rules": NonNullable<Json>,"version": number
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"org_id"?: string,"rules"?: NonNullable<Json>,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"outreach_items": {
                  Row: {
                    "assigned_member_id": string | null,"channel": Database["crm"]['Enums']["contact_type"],"created_at": string,"done_at": string | null,"due_on": string,"evidence_message_id": string | null,"id": string,"org_id": string,"party_id": string,"playbook_step": string,"skip_reason": string | null,"status": string,"suggested_message": string | null,"updated_at": string
                  }
                  Insert: {
                    "assigned_member_id"?: string | null,"channel": Database["crm"]['Enums']["contact_type"],"created_at"?: string,"done_at"?: string | null,"due_on"?: string,"evidence_message_id"?: string | null,"id"?: string,"org_id": string,"party_id": string,"playbook_step": string,"skip_reason"?: string | null,"status"?: string,"suggested_message"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "assigned_member_id"?: string | null,"channel"?: Database["crm"]['Enums']["contact_type"],"created_at"?: string,"done_at"?: string | null,"due_on"?: string,"evidence_message_id"?: string | null,"id"?: string,"org_id"?: string,"party_id"?: string,"playbook_step"?: string,"skip_reason"?: string | null,"status"?: string,"suggested_message"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outreach_items_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"parties": {
                  Row: {
                    "anonymized_at": string | null,"archived_at": string | null,"birth_date": string | null,"city": string | null,"cnpj": string | null,"created_at": string,"custom_fields": NonNullable<Json>,"display_name": string,"first_purchase_at": string | null,"first_touch_at": string,"gender": string | null,"home_store_id": string | null,"id": string,"instagram_handle": string | null,"joy_member_status": string,"kind": Database["crm"]['Enums']["party_kind"],"last_purchase_at": string | null,"lead_score": number,"legal_name": string | null,"lifecycle_stage": Database["crm"]['Enums']["lifecycle_stage"],"merged_into_id": string | null,"org_id": string,"preferences": NonNullable<Json>,"profession": string | null,"registry": Json | null,"registry_at": string | null,"relationship_owner_member_id": string | null,"score_breakdown": NonNullable<Json>,"sizes": NonNullable<Json>,"source": string | null,"tags": (string)[],"tier": Database["crm"]['Enums']["tier"],"tier_manual": boolean,"uf": string | null,"updated_at": string
                  }
                  Insert: {
                    "anonymized_at"?: string | null,"archived_at"?: string | null,"birth_date"?: string | null,"city"?: string | null,"cnpj"?: string | null,"created_at"?: string,"custom_fields"?: NonNullable<Json>,"display_name": string,"first_purchase_at"?: string | null,"first_touch_at"?: string,"gender"?: string | null,"home_store_id"?: string | null,"id"?: string,"instagram_handle"?: string | null,"joy_member_status"?: string,"kind"?: Database["crm"]['Enums']["party_kind"],"last_purchase_at"?: string | null,"lead_score"?: number,"legal_name"?: string | null,"lifecycle_stage"?: Database["crm"]['Enums']["lifecycle_stage"],"merged_into_id"?: string | null,"org_id": string,"preferences"?: NonNullable<Json>,"profession"?: string | null,"registry"?: Json | null,"registry_at"?: string | null,"relationship_owner_member_id"?: string | null,"score_breakdown"?: NonNullable<Json>,"sizes"?: NonNullable<Json>,"source"?: string | null,"tags"?: (string)[],"tier"?: Database["crm"]['Enums']["tier"],"tier_manual"?: boolean,"uf"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "anonymized_at"?: string | null,"archived_at"?: string | null,"birth_date"?: string | null,"city"?: string | null,"cnpj"?: string | null,"created_at"?: string,"custom_fields"?: NonNullable<Json>,"display_name"?: string,"first_purchase_at"?: string | null,"first_touch_at"?: string,"gender"?: string | null,"home_store_id"?: string | null,"id"?: string,"instagram_handle"?: string | null,"joy_member_status"?: string,"kind"?: Database["crm"]['Enums']["party_kind"],"last_purchase_at"?: string | null,"lead_score"?: number,"legal_name"?: string | null,"lifecycle_stage"?: Database["crm"]['Enums']["lifecycle_stage"],"merged_into_id"?: string | null,"org_id"?: string,"preferences"?: NonNullable<Json>,"profession"?: string | null,"registry"?: Json | null,"registry_at"?: string | null,"relationship_owner_member_id"?: string | null,"score_breakdown"?: NonNullable<Json>,"sizes"?: NonNullable<Json>,"source"?: string | null,"tags"?: (string)[],"tier"?: Database["crm"]['Enums']["tier"],"tier_manual"?: boolean,"uf"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "parties_merged_into_id_fkey"
      columns: ["merged_into_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_addresses": {
                  Row: {
                    "cep": string | null,"city": string | null,"complement": string | null,"created_at": string,"district": string | null,"id": string,"is_default": boolean,"label": string | null,"number": string | null,"org_id": string,"party_id": string,"street": string | null,"uf": string | null
                  }
                  Insert: {
                    "cep"?: string | null,"city"?: string | null,"complement"?: string | null,"created_at"?: string,"district"?: string | null,"id"?: string,"is_default"?: boolean,"label"?: string | null,"number"?: string | null,"org_id": string,"party_id": string,"street"?: string | null,"uf"?: string | null
                  }
                  Update: {
                    "cep"?: string | null,"city"?: string | null,"complement"?: string | null,"created_at"?: string,"district"?: string | null,"id"?: string,"is_default"?: boolean,"label"?: string | null,"number"?: string | null,"org_id"?: string,"party_id"?: string,"street"?: string | null,"uf"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_addresses_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_contact_points": {
                  Row: {
                    "created_at": string,"id": string,"is_primary": boolean,"org_id": string,"party_id": string,"type": Database["crm"]['Enums']["contact_type"],"value_display": string,"value_normalized": string,"verified_at": string | null
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_primary"?: boolean,"org_id": string,"party_id": string,"type": Database["crm"]['Enums']["contact_type"],"value_display": string,"value_normalized": string,"verified_at"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_primary"?: boolean,"org_id"?: string,"party_id"?: string,"type"?: Database["crm"]['Enums']["contact_type"],"value_display"?: string,"value_normalized"?: string,"verified_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_contact_points_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_merge_log": {
                  Row: {
                    "id": string,"kept_id": string,"merged_at": string,"merged_by": string | null,"merged_id": string,"merged_name": string,"moved": NonNullable<Json>,"org_id": string,"skipped": (string)[]
                  }
                  Insert: {
                    "id"?: string,"kept_id": string,"merged_at"?: string,"merged_by"?: string | null,"merged_id": string,"merged_name": string,"moved"?: NonNullable<Json>,"org_id": string,"skipped"?: (string)[]
                  }
                  Update: {
                    "id"?: string,"kept_id"?: string,"merged_at"?: string,"merged_by"?: string | null,"merged_id"?: string,"merged_name"?: string,"moved"?: NonNullable<Json>,"org_id"?: string,"skipped"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_merge_log_kept_id_fkey"
      columns: ["kept_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "party_merge_log_merged_id_fkey"
      columns: ["merged_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_relations": {
                  Row: {
                    "created_at": string,"created_by": string | null,"from_party": string,"id": string,"kind": string,"note": string | null,"org_id": string,"to_party": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"from_party": string,"id"?: string,"kind": string,"note"?: string | null,"org_id": string,"to_party": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"from_party"?: string,"id"?: string,"kind"?: string,"note"?: string | null,"org_id"?: string,"to_party"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_relations_from_party_fkey"
      columns: ["from_party"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "party_relations_to_party_fkey"
      columns: ["to_party"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_roles": {
                  Row: {
                    "created_at": string,"org_id": string,"party_id": string,"role": Database["crm"]['Enums']["party_role"]
                  }
                  Insert: {
                    "created_at"?: string,"org_id": string,"party_id": string,"role": Database["crm"]['Enums']["party_role"]
                  }
                  Update: {
                    "created_at"?: string,"org_id"?: string,"party_id"?: string,"role"?: Database["crm"]['Enums']["party_role"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_roles_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"party_sensitive": {
                  Row: {
                    "cpf_encrypted": string | null,"cpf_hmac": string | null,"cpf_last4": string | null,"org_id": string,"party_id": string,"updated_at": string
                  }
                  Insert: {
                    "cpf_encrypted"?: string | null,"cpf_hmac"?: string | null,"cpf_last4"?: string | null,"org_id": string,"party_id": string,"updated_at"?: string
                  }
                  Update: {
                    "cpf_encrypted"?: string | null,"cpf_hmac"?: string | null,"cpf_last4"?: string | null,"org_id"?: string,"party_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_sensitive_party_id_fkey"
      columns: ["party_id"]
isOneToOne: true
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"pipeline_stages": {
                  Row: {
                    "id": string,"is_lost": boolean,"is_won": boolean,"name": string,"org_id": string,"pipeline_id": string,"position": number,"probability": number,"sla_hours": number | null
                  }
                  Insert: {
                    "id"?: string,"is_lost"?: boolean,"is_won"?: boolean,"name": string,"org_id": string,"pipeline_id": string,"position": number,"probability"?: number,"sla_hours"?: number | null
                  }
                  Update: {
                    "id"?: string,"is_lost"?: boolean,"is_won"?: boolean,"name"?: string,"org_id"?: string,"pipeline_id"?: string,"position"?: number,"probability"?: number,"sla_hours"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "pipeline_stages_pipeline_id_fkey"
      columns: ["pipeline_id"]
isOneToOne: false
      referencedRelation: "pipelines"
      referencedColumns: ["id"]
    }
                  ]
                },"pipelines": {
                  Row: {
                    "active": boolean,"id": string,"kind": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "active"?: boolean,"id"?: string,"kind": string,"name": string,"org_id": string
                  }
                  Update: {
                    "active"?: boolean,"id"?: string,"kind"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"referrals": {
                  Row: {
                    "created_at": string,"friend_party": string,"id": string,"link_id": string | null,"order_id": string | null,"org_id": string,"referrer_party": string,"reject_reason": string | null,"reward_amount": number | null,"reward_ledger_id": number | null,"rewarded_at": string | null,"status": string
                  }
                  Insert: {
                    "created_at"?: string,"friend_party": string,"id"?: string,"link_id"?: string | null,"order_id"?: string | null,"org_id": string,"referrer_party": string,"reject_reason"?: string | null,"reward_amount"?: number | null,"reward_ledger_id"?: number | null,"rewarded_at"?: string | null,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"friend_party"?: string,"id"?: string,"link_id"?: string | null,"order_id"?: string | null,"org_id"?: string,"referrer_party"?: string,"reject_reason"?: string | null,"reward_amount"?: number | null,"reward_ledger_id"?: number | null,"rewarded_at"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "referrals_friend_party_fkey"
      columns: ["friend_party"]
isOneToOne: true
      referencedRelation: "parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "referrals_referrer_party_fkey"
      columns: ["referrer_party"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"segment_members": {
                  Row: {
                    "added_at": string,"org_id": string,"party_id": string,"segment_id": string
                  }
                  Insert: {
                    "added_at"?: string,"org_id": string,"party_id": string,"segment_id": string
                  }
                  Update: {
                    "added_at"?: string,"org_id"?: string,"party_id"?: string,"segment_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "segment_members_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "segment_members_segment_id_fkey"
      columns: ["segment_id"]
isOneToOne: false
      referencedRelation: "segments"
      referencedColumns: ["id"]
    }
                  ]
                },"segments": {
                  Row: {
                    "created_at": string,"definition": NonNullable<Json>,"id": string,"is_dynamic": boolean,"name": string,"org_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"definition"?: NonNullable<Json>,"id"?: string,"is_dynamic"?: boolean,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"definition"?: NonNullable<Json>,"id"?: string,"is_dynamic"?: boolean,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tasks": {
                  Row: {
                    "assignee_member_id": string | null,"body": string | null,"completed_at": string | null,"created_at": string,"created_by_ai": boolean,"deal_id": string | null,"due_at": string | null,"id": string,"org_id": string,"outcome_note": string | null,"party_id": string | null,"source_rule": string | null,"status": string,"suggested_message": string | null,"title": string,"type": string,"updated_at": string
                  }
                  Insert: {
                    "assignee_member_id"?: string | null,"body"?: string | null,"completed_at"?: string | null,"created_at"?: string,"created_by_ai"?: boolean,"deal_id"?: string | null,"due_at"?: string | null,"id"?: string,"org_id": string,"outcome_note"?: string | null,"party_id"?: string | null,"source_rule"?: string | null,"status"?: string,"suggested_message"?: string | null,"title": string,"type"?: string,"updated_at"?: string
                  }
                  Update: {
                    "assignee_member_id"?: string | null,"body"?: string | null,"completed_at"?: string | null,"created_at"?: string,"created_by_ai"?: boolean,"deal_id"?: string | null,"due_at"?: string | null,"id"?: string,"org_id"?: string,"outcome_note"?: string | null,"party_id"?: string | null,"source_rule"?: string | null,"status"?: string,"suggested_message"?: string | null,"title"?: string,"type"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_deal_id_fkey"
      columns: ["deal_id"]
isOneToOne: false
      referencedRelation: "deals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"timeline_events": {
                  Row: {
                    "id": number,"kind": string,"occurred_at": string,"org_id": string,"party_id": string,"payload": NonNullable<Json>,"source_id": string | null,"source_type": string | null,"summary": string
                  }
                  Insert: {
                    "id"?: never,"kind": string,"occurred_at"?: string,"org_id": string,"party_id": string,"payload"?: NonNullable<Json>,"source_id"?: string | null,"source_type"?: string | null,"summary": string
                  }
                  Update: {
                    "id"?: never,"kind"?: string,"occurred_at"?: string,"org_id"?: string,"party_id"?: string,"payload"?: NonNullable<Json>,"source_id"?: string | null,"source_type"?: string | null,"summary"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "timeline_events_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_current_consents": {
                  Row: {
                    "created_at": string | null,"evidence": Json | null,"granted": boolean | null,"legal_basis": Database["crm"]['Enums']["legal_basis"] | null,"org_id": string | null,"party_id": string | null,"purpose": Database["crm"]['Enums']["consent_purpose"] | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "consents_party_id_fkey"
      columns: ["party_id"]
isOneToOne: false
      referencedRelation: "parties"
      referencedColumns: ["id"]
    }
                  ]
                },"v_relatives": {
                  Row: {
                    "org_id": string | null,"party_id": string | null,"relation_id": string | null,"relative_id": string | null,"role": string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "add_contact":
{ Args: { "p_party": string,"p_primary"?: boolean,"p_type": Database["crm"]['Enums']["contact_type"],"p_value": string }; Returns: string
                           },
"add_interest":
{ Args: { "p_color"?: string,"p_note"?: string,"p_party": string,"p_product": string,"p_size": string }; Returns: {
              "color_id": string | null,
"created_at": string,
"created_by": string | null,
"created_via": string,
"id": string,
"note": string | null,
"notified_at": string | null,
"org_id": string,
"party_id": string,
"product_id": string,
"reservation_id": string | null,
"size": string,
"status": string
            }
                          SetofOptions: {
        from: "*"
        to: "interest_alerts"
        isOneToOne: true
        isSetofReturn: false
      } },
"add_relation":
{ Args: { "p_note"?: string,"p_other": string,"p_party": string,"p_role": string }; Returns: string
                           },
"assign_case":
{ Args: { "p_id": string,"p_member": string }; Returns: {
              "conversation_id": string | null,
"courtesy_amount": number,
"courtesy_ledger_id": number | null,
"description": string | null,
"first_response_at": string | null,
"first_response_due": string,
"followup_task_id": string | null,
"id": string,
"kind": string,
"late_alerted": boolean,
"number": string,
"opened_at": string,
"opened_by": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"resolve_due": string,
"resolved_at": string | null,
"solution": string | null,
"source": string,
"source_ref": string | null,
"status": string,
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"audience":
{ Args: { "p_def": Json }; Returns: {
              "party_id": string
            }[]
                           },
"cancel_interest":
{ Args: { "p_id": string }; Returns: undefined
                           },
"case_responded":
{ Args: { "p_id": string }; Returns: {
              "conversation_id": string | null,
"courtesy_amount": number,
"courtesy_ledger_id": number | null,
"description": string | null,
"first_response_at": string | null,
"first_response_due": string,
"followup_task_id": string | null,
"id": string,
"kind": string,
"late_alerted": boolean,
"number": string,
"opened_at": string,
"opened_by": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"resolve_due": string,
"resolved_at": string | null,
"solution": string | null,
"source": string,
"source_ref": string | null,
"status": string,
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_party":
{ Args: { "p": Json }; Returns: {
              "anonymized_at": string | null,
"archived_at": string | null,
"birth_date": string | null,
"city": string | null,
"cnpj": string | null,
"created_at": string,
"custom_fields": NonNullable<Json>,
"display_name": string,
"first_purchase_at": string | null,
"first_touch_at": string,
"gender": string | null,
"home_store_id": string | null,
"id": string,
"instagram_handle": string | null,
"joy_member_status": string,
"kind": Database["crm"]['Enums']["party_kind"],
"last_purchase_at": string | null,
"lead_score": number,
"legal_name": string | null,
"lifecycle_stage": Database["crm"]['Enums']["lifecycle_stage"],
"merged_into_id": string | null,
"org_id": string,
"preferences": NonNullable<Json>,
"profession": string | null,
"registry": Json | null,
"registry_at": string | null,
"relationship_owner_member_id": string | null,
"score_breakdown": NonNullable<Json>,
"sizes": NonNullable<Json>,
"source": string | null,
"tags": (string)[],
"tier": Database["crm"]['Enums']["tier"],
"tier_manual": boolean,
"uf": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "parties"
        isOneToOne: true
        isSetofReturn: false
      } },
"daily_actions":
{ Args: { "p_limit"?: number }; Returns: {
              "at_risk": boolean,"due_at": string,"overdue": boolean,"party_id": string,"party_name": string,"priority": number,"reason": string,"revenue_12m": number,"suggested_message": string,"task_id": string,"tier": string,"title": string,"type": string
            }[]
                           },
"delete_address":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_deal":
{ Args: { "p_id": string }; Returns: undefined
                           },
"duplicate_candidates":
{ Args: { "p_party": string }; Returns: {
              "display_name": string,"party_id": string,"reason": string
            }[]
                           },
"ensure_referral_link":
{ Args: { "p_party": string }; Returns: Database["mkt"]['Tables']["tracking_links"]['Row']
                          SetofOptions: {
        from: "*"
        to: "tracking_links"
        isOneToOne: true
        isSetofReturn: false
      } },
"finish_task":
{ Args: { "p_id": string,"p_note"?: string,"p_status": string }; Returns: {
              "assignee_member_id": string | null,
"body": string | null,
"completed_at": string | null,
"created_at": string,
"created_by_ai": boolean,
"deal_id": string | null,
"due_at": string | null,
"id": string,
"org_id": string,
"outcome_note": string | null,
"party_id": string | null,
"source_rule": string | null,
"status": string,
"suggested_message": string | null,
"title": string,
"type": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "tasks"
        isOneToOne: true
        isSetofReturn: false
      } },
"for_her_now":
{ Args: { "p_party": string }; Returns: Json
                           },
"generate_outreach":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"lead_sources":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "buyers": number,"leads": number,"source": string
            }[]
                           },
"lifecycle_overview":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"merge_parties":
{ Args: { "p_dup": string,"p_keep": string }; Returns: Json
                           },
"move_deal":
{ Args: { "p_deal": string,"p_reason"?: string,"p_stage": string }; Returns: {
              "conversation_id": string | null,
"created_at": string,
"id": string,
"lost_reason": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"pipeline_id": string,
"stage_id": string,
"status": string,
"title": string,
"updated_at": string,
"value_estimated": number | null,
"won_order_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "deals"
        isOneToOne: true
        isSetofReturn: false
      } },
"open_case":
{ Args: { "p": Json }; Returns: {
              "conversation_id": string | null,
"courtesy_amount": number,
"courtesy_ledger_id": number | null,
"description": string | null,
"first_response_at": string | null,
"first_response_due": string,
"followup_task_id": string | null,
"id": string,
"kind": string,
"late_alerted": boolean,
"number": string,
"opened_at": string,
"opened_by": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"resolve_due": string,
"resolved_at": string | null,
"solution": string | null,
"source": string,
"source_ref": string | null,
"status": string,
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"outreach_set_draft":
{ Args: { "p_id": string,"p_message": string }; Returns: undefined
                           },
"quick_customer":
{ Args: { "p_marketing_whatsapp"?: boolean,"p_name"?: string,"p_phone": string }; Returns: string
                           },
"record_nps":
{ Args: { "p_comment"?: string,"p_order"?: string,"p_party": string,"p_score": number }; Returns: Database["omni"]['Tables']["nps_responses"]['Row']
                          SetofOptions: {
        from: "*"
        to: "nps_responses"
        isOneToOne: true
        isSetofReturn: false
      } },
"refresh_lifecycle":
{ Args: { "p_party"?: string }; Returns: number
                           },
"relatives_of":
{ Args: { "p_party": string }; Returns: {
              "birth_date": string,"birthday_in_days": number,"gender": string,"note": string,"relation_id": string,"relative_id": string,"relative_name": string,"role": string
            }[]
                           },
"remove_contact":
{ Args: { "p_id": string }; Returns: undefined
                           },
"remove_relation":
{ Args: { "p_id": string }; Returns: undefined
                           },
"reopen_case":
{ Args: { "p_id": string }; Returns: {
              "conversation_id": string | null,
"courtesy_amount": number,
"courtesy_ledger_id": number | null,
"description": string | null,
"first_response_at": string | null,
"first_response_due": string,
"followup_task_id": string | null,
"id": string,
"kind": string,
"late_alerted": boolean,
"number": string,
"opened_at": string,
"opened_by": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"resolve_due": string,
"resolved_at": string | null,
"solution": string | null,
"source": string,
"source_ref": string | null,
"status": string,
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"report_acquisition":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "ad_spend": number,"avg_days_to_buy": number,"buyers": number,"conversion_pct": number,"cost_per_customer": number,"leads": number,"revenue": number,"source": string
            }[]
                           },
"report_lost_reasons":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "bought_later": number,"lost": number,"reason": string,"recovered_pct": number
            }[]
                           },
"reschedule_task":
{ Args: { "p_due": string,"p_id": string }; Returns: {
              "assignee_member_id": string | null,
"body": string | null,
"completed_at": string | null,
"created_at": string,
"created_by_ai": boolean,
"deal_id": string | null,
"due_at": string | null,
"id": string,
"org_id": string,
"outcome_note": string | null,
"party_id": string | null,
"source_rule": string | null,
"status": string,
"suggested_message": string | null,
"title": string,
"type": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "tasks"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_case":
{ Args: { "p_courtesy"?: number,"p_id": string,"p_solution": string }; Returns: {
              "conversation_id": string | null,
"courtesy_amount": number,
"courtesy_ledger_id": number | null,
"description": string | null,
"first_response_at": string | null,
"first_response_due": string,
"followup_task_id": string | null,
"id": string,
"kind": string,
"late_alerted": boolean,
"number": string,
"opened_at": string,
"opened_by": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"resolve_due": string,
"resolved_at": string | null,
"solution": string | null,
"source": string,
"source_ref": string | null,
"status": string,
"title": string
            }
                          SetofOptions: {
        from: "*"
        to: "cases"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_identity":
{ Args: { "p_display_name"?: string,"p_org": string,"p_source"?: string,"p_type": Database["crm"]['Enums']["contact_type"],"p_value": string }; Returns: string
                           },
"save_address":
{ Args: { "p": Json }; Returns: string
                           },
"save_deal":
{ Args: { "p": Json }; Returns: {
              "conversation_id": string | null,
"created_at": string,
"id": string,
"lost_reason": string | null,
"org_id": string,
"owner_member_id": string | null,
"party_id": string,
"pipeline_id": string,
"stage_id": string,
"status": string,
"title": string,
"updated_at": string,
"value_estimated": number | null,
"won_order_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "deals"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_lifecycle_settings":
{ Args: { "p": Json }; Returns: Json
                           },
"save_outreach_message":
{ Args: { "p_id": string,"p_message": string }; Returns: {
              "assigned_member_id": string | null,
"channel": Database["crm"]['Enums']["contact_type"],
"created_at": string,
"done_at": string | null,
"due_on": string,
"evidence_message_id": string | null,
"id": string,
"org_id": string,
"party_id": string,
"playbook_step": string,
"skip_reason": string | null,
"status": string,
"suggested_message": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "outreach_items"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_referral_settings":
{ Args: { "p": Json }; Returns: Json
                           },
"save_registry":
{ Args: { "p_data": Json,"p_party": string }; Returns: {
              "anonymized_at": string | null,
"archived_at": string | null,
"birth_date": string | null,
"city": string | null,
"cnpj": string | null,
"created_at": string,
"custom_fields": NonNullable<Json>,
"display_name": string,
"first_purchase_at": string | null,
"first_touch_at": string,
"gender": string | null,
"home_store_id": string | null,
"id": string,
"instagram_handle": string | null,
"joy_member_status": string,
"kind": Database["crm"]['Enums']["party_kind"],
"last_purchase_at": string | null,
"lead_score": number,
"legal_name": string | null,
"lifecycle_stage": Database["crm"]['Enums']["lifecycle_stage"],
"merged_into_id": string | null,
"org_id": string,
"preferences": NonNullable<Json>,
"profession": string | null,
"registry": Json | null,
"registry_at": string | null,
"relationship_owner_member_id": string | null,
"score_breakdown": NonNullable<Json>,
"sizes": NonNullable<Json>,
"source": string | null,
"tags": (string)[],
"tier": Database["crm"]['Enums']["tier"],
"tier_manual": boolean,
"uf": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "parties"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_task":
{ Args: { "p": Json }; Returns: {
              "assignee_member_id": string | null,
"body": string | null,
"completed_at": string | null,
"created_at": string,
"created_by_ai": boolean,
"deal_id": string | null,
"due_at": string | null,
"id": string,
"org_id": string,
"outcome_note": string | null,
"party_id": string | null,
"source_rule": string | null,
"status": string,
"suggested_message": string | null,
"title": string,
"type": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "tasks"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_tier_benefits":
{ Args: { "p": Json }; Returns: Json
                           },
"set_consent":
{ Args: { "p_channel": string,"p_granted": boolean,"p_party": string,"p_purpose": Database["crm"]['Enums']["consent_purpose"],"p_text_version"?: string }; Returns: undefined
                           },
"set_outreach_status":
{ Args: { "p_id": string,"p_note"?: string,"p_status": string }; Returns: {
              "assigned_member_id": string | null,
"channel": Database["crm"]['Enums']["contact_type"],
"created_at": string,
"done_at": string | null,
"due_on": string,
"evidence_message_id": string | null,
"id": string,
"org_id": string,
"party_id": string,
"playbook_step": string,
"skip_reason": string | null,
"status": string,
"suggested_message": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "outreach_items"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_party_roles":
{ Args: { "p_party": string,"p_roles": (string)[] }; Returns: undefined
                           },
"set_task_status":
{ Args: { "p_id": string,"p_status": string }; Returns: {
              "assignee_member_id": string | null,
"body": string | null,
"completed_at": string | null,
"created_at": string,
"created_by_ai": boolean,
"deal_id": string | null,
"due_at": string | null,
"id": string,
"org_id": string,
"outcome_note": string | null,
"party_id": string | null,
"source_rule": string | null,
"status": string,
"suggested_message": string | null,
"title": string,
"type": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "tasks"
        isOneToOne: true
        isSetofReturn: false
      } },
"tier_benefits":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"update_party_identity":
{ Args: { "p": Json,"p_party": string }; Returns: {
              "anonymized_at": string | null,
"archived_at": string | null,
"birth_date": string | null,
"city": string | null,
"cnpj": string | null,
"created_at": string,
"custom_fields": NonNullable<Json>,
"display_name": string,
"first_purchase_at": string | null,
"first_touch_at": string,
"gender": string | null,
"home_store_id": string | null,
"id": string,
"instagram_handle": string | null,
"joy_member_status": string,
"kind": Database["crm"]['Enums']["party_kind"],
"last_purchase_at": string | null,
"lead_score": number,
"legal_name": string | null,
"lifecycle_stage": Database["crm"]['Enums']["lifecycle_stage"],
"merged_into_id": string | null,
"org_id": string,
"preferences": NonNullable<Json>,
"profession": string | null,
"registry": Json | null,
"registry_at": string | null,
"relationship_owner_member_id": string | null,
"score_breakdown": NonNullable<Json>,
"sizes": NonNullable<Json>,
"source": string | null,
"tags": (string)[],
"tier": Database["crm"]['Enums']["tier"],
"tier_manual": boolean,
"uf": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "parties"
        isOneToOne: true
        isSetofReturn: false
      } },
"update_profile":
{ Args: { "p": Json,"p_party": string }; Returns: {
              "anonymized_at": string | null,
"archived_at": string | null,
"birth_date": string | null,
"city": string | null,
"cnpj": string | null,
"created_at": string,
"custom_fields": NonNullable<Json>,
"display_name": string,
"first_purchase_at": string | null,
"first_touch_at": string,
"gender": string | null,
"home_store_id": string | null,
"id": string,
"instagram_handle": string | null,
"joy_member_status": string,
"kind": Database["crm"]['Enums']["party_kind"],
"last_purchase_at": string | null,
"lead_score": number,
"legal_name": string | null,
"lifecycle_stage": Database["crm"]['Enums']["lifecycle_stage"],
"merged_into_id": string | null,
"org_id": string,
"preferences": NonNullable<Json>,
"profession": string | null,
"registry": Json | null,
"registry_at": string | null,
"relationship_owner_member_id": string | null,
"score_breakdown": NonNullable<Json>,
"sizes": NonNullable<Json>,
"source": string | null,
"tags": (string)[],
"tier": Database["crm"]['Enums']["tier"],
"tier_manual": boolean,
"uf": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "parties"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            "consent_purpose": "TRANSACTIONAL"|"MARKETING_WHATSAPP"|"MARKETING_EMAIL"|"MARKETING_IG"|"AI_PROFILING"|"ENRICHMENT"|"IMAGE_USE","contact_type": "PHONE"|"EMAIL"|"WHATSAPP"|"INSTAGRAM"|"TELEGRAM"|"TIKTOK","legal_basis": "CONSENT"|"LEGITIMATE_INTEREST"|"CONTRACT"|"LEGAL_OBLIGATION","lifecycle_stage": "LEAD"|"PROSPECT"|"CUSTOMER"|"VIP"|"INACTIVE"|"LOST","party_kind": "PERSON"|"COMPANY","party_role": "CUSTOMER"|"SUPPLIER"|"EMPLOYEE"|"AFFILIATE_TRAINER"|"PARTNER_GYM"|"INFLUENCER"|"CARRIER"|"SERVICE_PROVIDER"|"SHAREHOLDER"|"ACQUIRER"|"BANK","tier": "STANDARD"|"VIP"|"VIP_BLACK"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"fin": {
          Tables: {
            "account_roles": {
                  Row: {
                    "chart_account_id": string,"org_id": string,"role": string
                  }
                  Insert: {
                    "chart_account_id": string,"org_id": string,"role": string
                  }
                  Update: {
                    "chart_account_id"?: string,"org_id"?: string,"role"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "account_roles_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"acquirer_fee_plans": {
                  Row: {
                    "acquirer": string,"anticipation_mode": string,"id": string,"inst_from": number,"inst_to": number,"method": string,"org_id": string,"rate": number,"settlement_days": number,"valid_from": string,"valid_to": string | null
                  }
                  Insert: {
                    "acquirer": string,"anticipation_mode": string,"id"?: string,"inst_from"?: number,"inst_to"?: number,"method": string,"org_id": string,"rate": number,"settlement_days"?: number,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Update: {
                    "acquirer"?: string,"anticipation_mode"?: string,"id"?: string,"inst_from"?: number,"inst_to"?: number,"method"?: string,"org_id"?: string,"rate"?: number,"settlement_days"?: number,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"acquirer_imports": {
                  Row: {
                    "acquirer": string,"created_at": string,"created_by": string | null,"file_hash": string | null,"filename": string | null,"id": string,"org_id": string,"transactions_new": number,"transactions_total": number
                  }
                  Insert: {
                    "acquirer": string,"created_at"?: string,"created_by"?: string | null,"file_hash"?: string | null,"filename"?: string | null,"id"?: string,"org_id": string,"transactions_new"?: number,"transactions_total"?: number
                  }
                  Update: {
                    "acquirer"?: string,"created_at"?: string,"created_by"?: string | null,"file_hash"?: string | null,"filename"?: string | null,"id"?: string,"org_id"?: string,"transactions_new"?: number,"transactions_total"?: number
                  }
                  Relationships: [
                    
                  ]
                },"acquirer_payouts": {
                  Row: {
                    "acquirer": string,"amount": number,"bank_account_id": string | null,"created_at": string,"external_id": string,"id": string,"import_id": string | null,"org_id": string,"paid_on": string,"settlement_id": string | null,"status": string
                  }
                  Insert: {
                    "acquirer": string,"amount": number,"bank_account_id"?: string | null,"created_at"?: string,"external_id": string,"id"?: string,"import_id"?: string | null,"org_id": string,"paid_on": string,"settlement_id"?: string | null,"status"?: string
                  }
                  Update: {
                    "acquirer"?: string,"amount"?: number,"bank_account_id"?: string | null,"created_at"?: string,"external_id"?: string,"id"?: string,"import_id"?: string | null,"org_id"?: string,"paid_on"?: string,"settlement_id"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "acquirer_payouts_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "acquirer_payouts_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "v_bank_balances"
      referencedColumns: ["bank_account_id"]
    },{
      foreignKeyName: "acquirer_payouts_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "acquirer_imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "acquirer_payouts_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "settlements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "acquirer_payouts_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "v_fee_audit"
      referencedColumns: ["settlement_id"]
    }
                  ]
                },"acquirer_receivables": {
                  Row: {
                    "anticipation_fee": number,"expected_date": string | null,"gross": number,"id": string,"installment_id": string | null,"mdr_fee": number,"n": number,"net": number,"org_id": string,"payout_id": string | null,"status": string,"transaction_id": string
                  }
                  Insert: {
                    "anticipation_fee"?: number,"expected_date"?: string | null,"gross": number,"id"?: string,"installment_id"?: string | null,"mdr_fee"?: number,"n": number,"net": number,"org_id": string,"payout_id"?: string | null,"status"?: string,"transaction_id": string
                  }
                  Update: {
                    "anticipation_fee"?: number,"expected_date"?: string | null,"gross"?: number,"id"?: string,"installment_id"?: string | null,"mdr_fee"?: number,"n"?: number,"net"?: number,"org_id"?: string,"payout_id"?: string | null,"status"?: string,"transaction_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "acquirer_receivables_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "title_installments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "acquirer_receivables_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "v_open_installments"
      referencedColumns: ["installment_id"]
    },{
      foreignKeyName: "acquirer_receivables_payout_id_fkey"
      columns: ["payout_id"]
isOneToOne: false
      referencedRelation: "acquirer_payouts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "acquirer_receivables_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "acquirer_transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"acquirer_transactions": {
                  Row: {
                    "acquirer": string,"anticipation_fee": number,"auth_code": string | null,"brand": string | null,"captured_at": string,"created_at": string,"external_id": string,"fee_expected": number | null,"fee_variance": number | null,"gross": number,"id": string,"import_id": string | null,"installments": number,"last4": string | null,"match_status": string,"mdr_fee": number,"method": Database["sales"]['Enums']["payment_method"],"nsu": string | null,"org_id": string,"payment_id": string | null,"raw": NonNullable<Json>,"terminal": string | null
                  }
                  Insert: {
                    "acquirer": string,"anticipation_fee"?: number,"auth_code"?: string | null,"brand"?: string | null,"captured_at": string,"created_at"?: string,"external_id": string,"fee_expected"?: number | null,"fee_variance"?: number | null,"gross": number,"id"?: string,"import_id"?: string | null,"installments"?: number,"last4"?: string | null,"match_status"?: string,"mdr_fee"?: number,"method": Database["sales"]['Enums']["payment_method"],"nsu"?: string | null,"org_id": string,"payment_id"?: string | null,"raw"?: NonNullable<Json>,"terminal"?: string | null
                  }
                  Update: {
                    "acquirer"?: string,"anticipation_fee"?: number,"auth_code"?: string | null,"brand"?: string | null,"captured_at"?: string,"created_at"?: string,"external_id"?: string,"fee_expected"?: number | null,"fee_variance"?: number | null,"gross"?: number,"id"?: string,"import_id"?: string | null,"installments"?: number,"last4"?: string | null,"match_status"?: string,"mdr_fee"?: number,"method"?: Database["sales"]['Enums']["payment_method"],"nsu"?: string | null,"org_id"?: string,"payment_id"?: string | null,"raw"?: NonNullable<Json>,"terminal"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "acquirer_transactions_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "acquirer_imports"
      referencedColumns: ["id"]
    }
                  ]
                },"allocation_batches": {
                  Row: {
                    "competence": string,"created_at": string,"created_by": string | null,"detail": NonNullable<Json>,"entry_ids": (string)[],"id": string,"legal_entity_id": string,"org_id": string,"reversal_reason": string | null,"reversed_at": string | null,"reversed_by": string | null,"status": string,"total": number
                  }
                  Insert: {
                    "competence": string,"created_at"?: string,"created_by"?: string | null,"detail"?: NonNullable<Json>,"entry_ids"?: (string)[],"id"?: string,"legal_entity_id": string,"org_id": string,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"status"?: string,"total"?: number
                  }
                  Update: {
                    "competence"?: string,"created_at"?: string,"created_by"?: string | null,"detail"?: NonNullable<Json>,"entry_ids"?: (string)[],"id"?: string,"legal_entity_id"?: string,"org_id"?: string,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"status"?: string,"total"?: number
                  }
                  Relationships: [
                    
                  ]
                },"allocation_rules": {
                  Row: {
                    "account_ids": (string)[] | null,"active": boolean,"created_at": string,"id": string,"legal_entity_id": string | null,"method": string,"name": string,"notes": string | null,"org_id": string,"rounding_cost_center_id": string | null,"source_cost_center_id": string,"targets": NonNullable<Json>,"valid_from": string,"valid_to": string | null
                  }
                  Insert: {
                    "account_ids"?: (string)[] | null,"active"?: boolean,"created_at"?: string,"id"?: string,"legal_entity_id"?: string | null,"method": string,"name": string,"notes"?: string | null,"org_id": string,"rounding_cost_center_id"?: string | null,"source_cost_center_id": string,"targets": NonNullable<Json>,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Update: {
                    "account_ids"?: (string)[] | null,"active"?: boolean,"created_at"?: string,"id"?: string,"legal_entity_id"?: string | null,"method"?: string,"name"?: string,"notes"?: string | null,"org_id"?: string,"rounding_cost_center_id"?: string | null,"source_cost_center_id"?: string,"targets"?: NonNullable<Json>,"valid_from"?: string,"valid_to"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"allocation_template_lines": {
                  Row: {
                    "cost_center_id": string,"id": string,"org_id": string,"pct": number,"template_id": string
                  }
                  Insert: {
                    "cost_center_id": string,"id"?: string,"org_id": string,"pct": number,"template_id": string
                  }
                  Update: {
                    "cost_center_id"?: string,"id"?: string,"org_id"?: string,"pct"?: number,"template_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "allocation_template_lines_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "allocation_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"allocation_templates": {
                  Row: {
                    "active": boolean,"description": string | null,"id": string,"name": string,"org_id": string
                  }
                  Insert: {
                    "active"?: boolean,"description"?: string | null,"id"?: string,"name": string,"org_id": string
                  }
                  Update: {
                    "active"?: boolean,"description"?: string | null,"id"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"bank_accounts": {
                  Row: {
                    "active": boolean,"agency": string | null,"bank_code": string | null,"chart_account_id": string | null,"connection_id": string | null,"created_at": string,"id": string,"kind": string,"legal_entity_id": string,"name": string,"number": string | null,"opening_balance": number,"opening_date": string | null,"org_id": string,"pix_keys": (string)[],"store_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"agency"?: string | null,"bank_code"?: string | null,"chart_account_id"?: string | null,"connection_id"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"legal_entity_id": string,"name": string,"number"?: string | null,"opening_balance"?: number,"opening_date"?: string | null,"org_id": string,"pix_keys"?: (string)[],"store_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"agency"?: string | null,"bank_code"?: string | null,"chart_account_id"?: string | null,"connection_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"name"?: string,"number"?: string | null,"opening_balance"?: number,"opening_date"?: string | null,"org_id"?: string,"pix_keys"?: (string)[],"store_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "bank_accounts_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"budget_lines": {
                  Row: {
                    "amount": number,"budget_id": string,"chart_account_id": string,"cost_center_id": string | null,"id": string,"month": string,"org_id": string
                  }
                  Insert: {
                    "amount": number,"budget_id": string,"chart_account_id": string,"cost_center_id"?: string | null,"id"?: string,"month": string,"org_id": string
                  }
                  Update: {
                    "amount"?: number,"budget_id"?: string,"chart_account_id"?: string,"cost_center_id"?: string | null,"id"?: string,"month"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_lines_budget_id_fkey"
      columns: ["budget_id"]
isOneToOne: false
      referencedRelation: "budgets"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "budget_lines_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"budgets": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"legal_entity_id": string,"name": string,"notes": string | null,"org_id": string,"scenario": string,"status": string,"version": number,"year": number
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"legal_entity_id": string,"name"?: string,"notes"?: string | null,"org_id": string,"scenario"?: string,"status"?: string,"version"?: number,"year": number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"legal_entity_id"?: string,"name"?: string,"notes"?: string | null,"org_id"?: string,"scenario"?: string,"status"?: string,"version"?: number,"year"?: number
                  }
                  Relationships: [
                    
                  ]
                },"cash_transactions": {
                  Row: {
                    "amount": number,"bank_account_id": string,"chart_account_id": string | null,"cost_center_id": string | null,"created_at": string,"created_by": string | null,"description": string | null,"id": string,"journal_entry_id": string | null,"kind": string,"legal_entity_id": string,"occurred_on": string,"org_id": string,"party_id": string | null,"reconciled": boolean,"reconciled_amount": number,"reference": string | null,"reversal_of_id": string | null,"settlement_id": string | null,"transfer_group_id": string | null,"voided": boolean
                  }
                  Insert: {
                    "amount": number,"bank_account_id": string,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"kind": string,"legal_entity_id": string,"occurred_on": string,"org_id": string,"party_id"?: string | null,"reconciled"?: boolean,"reconciled_amount"?: number,"reference"?: string | null,"reversal_of_id"?: string | null,"settlement_id"?: string | null,"transfer_group_id"?: string | null,"voided"?: boolean
                  }
                  Update: {
                    "amount"?: number,"bank_account_id"?: string,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"kind"?: string,"legal_entity_id"?: string,"occurred_on"?: string,"org_id"?: string,"party_id"?: string | null,"reconciled"?: boolean,"reconciled_amount"?: number,"reference"?: string | null,"reversal_of_id"?: string | null,"settlement_id"?: string | null,"transfer_group_id"?: string | null,"voided"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_transactions_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_transactions_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "v_bank_balances"
      referencedColumns: ["bank_account_id"]
    },{
      foreignKeyName: "cash_transactions_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_transactions_journal_entry_id_fkey"
      columns: ["journal_entry_id"]
isOneToOne: false
      referencedRelation: "journal_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_transactions_reversal_of_id_fkey"
      columns: ["reversal_of_id"]
isOneToOne: false
      referencedRelation: "cash_transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_transactions_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "settlements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cash_transactions_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "v_fee_audit"
      referencedColumns: ["settlement_id"]
    }
                  ]
                },"chart_accounts": {
                  Row: {
                    "accountant_code": string | null,"archived_at": string | null,"cash_flow_group": string | null,"code": string,"created_at": string,"dre_line_id": string | null,"group": Database["fin"]['Enums']["account_group"],"id": string,"kind": string,"name": string,"nature": string,"org_id": string,"parent_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "accountant_code"?: string | null,"archived_at"?: string | null,"cash_flow_group"?: string | null,"code": string,"created_at"?: string,"dre_line_id"?: string | null,"group": Database["fin"]['Enums']["account_group"],"id"?: string,"kind": string,"name": string,"nature": string,"org_id": string,"parent_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "accountant_code"?: string | null,"archived_at"?: string | null,"cash_flow_group"?: string | null,"code"?: string,"created_at"?: string,"dre_line_id"?: string | null,"group"?: Database["fin"]['Enums']["account_group"],"id"?: string,"kind"?: string,"name"?: string,"nature"?: string,"org_id"?: string,"parent_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "chart_accounts_dre_line_id_fkey"
      columns: ["dre_line_id"]
isOneToOne: false
      referencedRelation: "dre_lines"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "chart_accounts_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"contract_obligations": {
                  Row: {
                    "contract_id": string,"description": string,"done_at": string | null,"due_date": string,"evidence": NonNullable<Json>,"id": string,"kind": string,"org_id": string,"status": string
                  }
                  Insert: {
                    "contract_id": string,"description": string,"done_at"?: string | null,"due_date": string,"evidence"?: NonNullable<Json>,"id"?: string,"kind": string,"org_id": string,"status"?: string
                  }
                  Update: {
                    "contract_id"?: string,"description"?: string,"done_at"?: string | null,"due_date"?: string,"evidence"?: NonNullable<Json>,"id"?: string,"kind"?: string,"org_id"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contract_obligations_contract_id_fkey"
      columns: ["contract_id"]
isOneToOne: false
      referencedRelation: "contracts"
      referencedColumns: ["id"]
    }
                  ]
                },"contracts": {
                  Row: {
                    "adjustment_index": string | null,"attachment_id": string | null,"chart_account_id": string | null,"cost_center_id": string | null,"created_at": string,"due_day": number | null,"exit_penalty_pct": number | null,"id": string,"in_kind_description": string | null,"in_kind_months": number,"installment_amount": number | null,"kind": string,"late_fee_pct": number | null,"legal_entity_id": string,"monthly_interest_pct": number | null,"months": number,"org_id": string,"party_id": string,"revenue_share_pct": number | null,"start_date": string,"status": string,"store_id": string | null,"title": string,"updated_at": string
                  }
                  Insert: {
                    "adjustment_index"?: string | null,"attachment_id"?: string | null,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"due_day"?: number | null,"exit_penalty_pct"?: number | null,"id"?: string,"in_kind_description"?: string | null,"in_kind_months"?: number,"installment_amount"?: number | null,"kind": string,"late_fee_pct"?: number | null,"legal_entity_id": string,"monthly_interest_pct"?: number | null,"months": number,"org_id": string,"party_id": string,"revenue_share_pct"?: number | null,"start_date": string,"status"?: string,"store_id"?: string | null,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "adjustment_index"?: string | null,"attachment_id"?: string | null,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"due_day"?: number | null,"exit_penalty_pct"?: number | null,"id"?: string,"in_kind_description"?: string | null,"in_kind_months"?: number,"installment_amount"?: number | null,"kind"?: string,"late_fee_pct"?: number | null,"legal_entity_id"?: string,"monthly_interest_pct"?: number | null,"months"?: number,"org_id"?: string,"party_id"?: string,"revenue_share_pct"?: number | null,"start_date"?: string,"status"?: string,"store_id"?: string | null,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "contracts_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"dre_lines": {
                  Row: {
                    "code": string,"formula": string | null,"id": string,"is_subtotal": boolean,"name": string,"org_id": string,"position": number,"sign": number
                  }
                  Insert: {
                    "code": string,"formula"?: string | null,"id"?: string,"is_subtotal"?: boolean,"name": string,"org_id": string,"position": number,"sign": number
                  }
                  Update: {
                    "code"?: string,"formula"?: string | null,"id"?: string,"is_subtotal"?: boolean,"name"?: string,"org_id"?: string,"position"?: number,"sign"?: number
                  }
                  Relationships: [
                    
                  ]
                },"journal_entries": {
                  Row: {
                    "created_at": string,"created_by": string | null,"description": string,"entry_date": string,"id": string,"kind": string,"ledger": string,"legal_entity_id": string,"number": string,"org_id": string,"reversal_of_id": string | null,"source_id": string | null,"source_type": string | null
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"description": string,"entry_date": string,"id"?: string,"kind": string,"ledger"?: string,"legal_entity_id": string,"number": string,"org_id": string,"reversal_of_id"?: string | null,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"description"?: string,"entry_date"?: string,"id"?: string,"kind"?: string,"ledger"?: string,"legal_entity_id"?: string,"number"?: string,"org_id"?: string,"reversal_of_id"?: string | null,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "journal_entries_reversal_of_id_fkey"
      columns: ["reversal_of_id"]
isOneToOne: false
      referencedRelation: "journal_entries"
      referencedColumns: ["id"]
    }
                  ]
                },"journal_lines": {
                  Row: {
                    "account_id": string,"cost_center_id": string | null,"credit": number,"debit": number,"entry_id": string,"id": number,"line_no": number,"memo": string | null,"org_id": string,"party_id": string | null
                  }
                  Insert: {
                    "account_id": string,"cost_center_id"?: string | null,"credit"?: number,"debit"?: number,"entry_id": string,"id"?: never,"line_no": number,"memo"?: string | null,"org_id": string,"party_id"?: string | null
                  }
                  Update: {
                    "account_id"?: string,"cost_center_id"?: string | null,"credit"?: number,"debit"?: number,"entry_id"?: string,"id"?: never,"line_no"?: number,"memo"?: string | null,"org_id"?: string,"party_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "journal_lines_account_id_fkey"
      columns: ["account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "journal_lines_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "journal_entries"
      referencedColumns: ["id"]
    }
                  ]
                },"party_credits": {
                  Row: {
                    "amount": number,"created_at": string,"direction": Database["fin"]['Enums']["title_direction"],"id": string,"legal_entity_id": string,"memo": string | null,"org_id": string,"party_id": string | null,"source_settlement_id": string | null,"status": string,"used": number
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"direction": Database["fin"]['Enums']["title_direction"],"id"?: string,"legal_entity_id": string,"memo"?: string | null,"org_id": string,"party_id"?: string | null,"source_settlement_id"?: string | null,"status"?: string,"used"?: number
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"direction"?: Database["fin"]['Enums']["title_direction"],"id"?: string,"legal_entity_id"?: string,"memo"?: string | null,"org_id"?: string,"party_id"?: string | null,"source_settlement_id"?: string | null,"status"?: string,"used"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "party_credits_settlement_fk"
      columns: ["source_settlement_id"]
isOneToOne: false
      referencedRelation: "settlements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "party_credits_settlement_fk"
      columns: ["source_settlement_id"]
isOneToOne: false
      referencedRelation: "v_fee_audit"
      referencedColumns: ["settlement_id"]
    }
                  ]
                },"periods": {
                  Row: {
                    "closed_at": string | null,"closed_by": string | null,"competence": string,"id": string,"legal_entity_id": string,"notes": string | null,"org_id": string,"status": string
                  }
                  Insert: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"competence": string,"id"?: string,"legal_entity_id": string,"notes"?: string | null,"org_id": string,"status"?: string
                  }
                  Update: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"competence"?: string,"id"?: string,"legal_entity_id"?: string,"notes"?: string | null,"org_id"?: string,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                },"recon_rules": {
                  Row: {
                    "action_kind": string,"active": boolean,"chart_account_id": string | null,"cost_center_id": string | null,"direction": string,"field": string,"id": string,"name": string,"org_id": string,"party_id": string | null,"pattern": string,"priority": number
                  }
                  Insert: {
                    "action_kind": string,"active"?: boolean,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"direction"?: string,"field"?: string,"id"?: string,"name": string,"org_id": string,"party_id"?: string | null,"pattern": string,"priority"?: number
                  }
                  Update: {
                    "action_kind"?: string,"active"?: boolean,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"direction"?: string,"field"?: string,"id"?: string,"name"?: string,"org_id"?: string,"party_id"?: string | null,"pattern"?: string,"priority"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "recon_rules_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"reconciliation_links": {
                  Row: {
                    "amount": number,"cash_transaction_id": string,"created_at": string,"created_by": string | null,"id": string,"method": string,"org_id": string,"statement_line_id": string
                  }
                  Insert: {
                    "amount": number,"cash_transaction_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"method"?: string,"org_id": string,"statement_line_id": string
                  }
                  Update: {
                    "amount"?: number,"cash_transaction_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"method"?: string,"org_id"?: string,"statement_line_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reconciliation_links_cash_transaction_id_fkey"
      columns: ["cash_transaction_id"]
isOneToOne: false
      referencedRelation: "cash_transactions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reconciliation_links_statement_line_id_fkey"
      columns: ["statement_line_id"]
isOneToOne: false
      referencedRelation: "statement_lines"
      referencedColumns: ["id"]
    }
                  ]
                },"recurring_templates": {
                  Row: {
                    "active": boolean,"allocation_template_id": string | null,"amount": number,"auto_approve": boolean,"chart_account_id": string | null,"cost_center_id": string | null,"created_at": string,"created_by": string | null,"day_of_month": number,"description": string,"direction": Database["fin"]['Enums']["title_direction"],"document_kind": string,"end_date": string | null,"id": string,"legal_entity_id": string,"next_run": string,"notes": string | null,"org_id": string,"party_id": string | null,"start_date": string,"store_id": string | null
                  }
                  Insert: {
                    "active"?: boolean,"allocation_template_id"?: string | null,"amount": number,"auto_approve"?: boolean,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"day_of_month": number,"description": string,"direction"?: Database["fin"]['Enums']["title_direction"],"document_kind"?: string,"end_date"?: string | null,"id"?: string,"legal_entity_id": string,"next_run": string,"notes"?: string | null,"org_id": string,"party_id"?: string | null,"start_date": string,"store_id"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"allocation_template_id"?: string | null,"amount"?: number,"auto_approve"?: boolean,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"day_of_month"?: number,"description"?: string,"direction"?: Database["fin"]['Enums']["title_direction"],"document_kind"?: string,"end_date"?: string | null,"id"?: string,"legal_entity_id"?: string,"next_run"?: string,"notes"?: string | null,"org_id"?: string,"party_id"?: string | null,"start_date"?: string,"store_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "recurring_templates_allocation_template_id_fkey"
      columns: ["allocation_template_id"]
isOneToOne: false
      referencedRelation: "allocation_templates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recurring_templates_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"settlement_lines": {
                  Row: {
                    "amount": number,"cash_effect": number,"chart_account_id": string | null,"cost_center_id": string | null,"credit_id": string | null,"id": string,"installment_id": string | null,"kind": string,"line_no": number,"memo": string | null,"org_id": string,"settlement_id": string
                  }
                  Insert: {
                    "amount": number,"cash_effect": number,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"credit_id"?: string | null,"id"?: string,"installment_id"?: string | null,"kind": string,"line_no": number,"memo"?: string | null,"org_id": string,"settlement_id": string
                  }
                  Update: {
                    "amount"?: number,"cash_effect"?: number,"chart_account_id"?: string | null,"cost_center_id"?: string | null,"credit_id"?: string | null,"id"?: string,"installment_id"?: string | null,"kind"?: string,"line_no"?: number,"memo"?: string | null,"org_id"?: string,"settlement_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "settlement_lines_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_lines_credit_id_fkey"
      columns: ["credit_id"]
isOneToOne: false
      referencedRelation: "party_credits"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_lines_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "title_installments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_lines_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "v_open_installments"
      referencedColumns: ["installment_id"]
    },{
      foreignKeyName: "settlement_lines_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "settlements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_lines_settlement_id_fkey"
      columns: ["settlement_id"]
isOneToOne: false
      referencedRelation: "v_fee_audit"
      referencedColumns: ["settlement_id"]
    }
                  ]
                },"settlements": {
                  Row: {
                    "amount": number,"bank_account_id": string,"created_at": string,"created_by": string | null,"description": string | null,"direction": Database["fin"]['Enums']["title_direction"],"id": string,"idempotency_key": string | null,"legal_entity_id": string,"method": string,"number": string,"org_id": string,"party_id": string | null,"reference": string | null,"reversal_reason": string | null,"reversed_at": string | null,"reversed_by": string | null,"settled_on": string,"status": string
                  }
                  Insert: {
                    "amount": number,"bank_account_id": string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"direction": Database["fin"]['Enums']["title_direction"],"id"?: string,"idempotency_key"?: string | null,"legal_entity_id": string,"method": string,"number": string,"org_id": string,"party_id"?: string | null,"reference"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"settled_on": string,"status"?: string
                  }
                  Update: {
                    "amount"?: number,"bank_account_id"?: string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"direction"?: Database["fin"]['Enums']["title_direction"],"id"?: string,"idempotency_key"?: string | null,"legal_entity_id"?: string,"method"?: string,"number"?: string,"org_id"?: string,"party_id"?: string | null,"reference"?: string | null,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"settled_on"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "settlements_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlements_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "v_bank_balances"
      referencedColumns: ["bank_account_id"]
    }
                  ]
                },"statement_imports": {
                  Row: {
                    "bank_account_id": string,"closing_balance": number | null,"created_at": string,"created_by": string | null,"file_hash": string | null,"filename": string | null,"id": string,"lines_new": number,"lines_total": number,"opening_balance": number | null,"org_id": string,"period_end": string | null,"period_start": string | null,"source": string
                  }
                  Insert: {
                    "bank_account_id": string,"closing_balance"?: number | null,"created_at"?: string,"created_by"?: string | null,"file_hash"?: string | null,"filename"?: string | null,"id"?: string,"lines_new"?: number,"lines_total"?: number,"opening_balance"?: number | null,"org_id": string,"period_end"?: string | null,"period_start"?: string | null,"source": string
                  }
                  Update: {
                    "bank_account_id"?: string,"closing_balance"?: number | null,"created_at"?: string,"created_by"?: string | null,"file_hash"?: string | null,"filename"?: string | null,"id"?: string,"lines_new"?: number,"lines_total"?: number,"opening_balance"?: number | null,"org_id"?: string,"period_end"?: string | null,"period_start"?: string | null,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "statement_imports_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "statement_imports_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "v_bank_balances"
      referencedColumns: ["bank_account_id"]
    }
                  ]
                },"statement_lines": {
                  Row: {
                    "amount": number,"balance_after": number | null,"bank_account_id": string,"counterpart_doc": string | null,"counterpart_name": string | null,"created_at": string,"dedupe_key": string,"description": string | null,"e2e_id": string | null,"external_id": string | null,"id": string,"ignore_reason": string | null,"import_id": string | null,"legal_entity_id": string,"matched_amount": number,"org_id": string,"posted_on": string,"raw": NonNullable<Json>,"status": string
                  }
                  Insert: {
                    "amount": number,"balance_after"?: number | null,"bank_account_id": string,"counterpart_doc"?: string | null,"counterpart_name"?: string | null,"created_at"?: string,"dedupe_key": string,"description"?: string | null,"e2e_id"?: string | null,"external_id"?: string | null,"id"?: string,"ignore_reason"?: string | null,"import_id"?: string | null,"legal_entity_id": string,"matched_amount"?: number,"org_id": string,"posted_on": string,"raw"?: NonNullable<Json>,"status"?: string
                  }
                  Update: {
                    "amount"?: number,"balance_after"?: number | null,"bank_account_id"?: string,"counterpart_doc"?: string | null,"counterpart_name"?: string | null,"created_at"?: string,"dedupe_key"?: string,"description"?: string | null,"e2e_id"?: string | null,"external_id"?: string | null,"id"?: string,"ignore_reason"?: string | null,"import_id"?: string | null,"legal_entity_id"?: string,"matched_amount"?: number,"org_id"?: string,"posted_on"?: string,"raw"?: NonNullable<Json>,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "statement_lines_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "bank_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "statement_lines_bank_account_id_fkey"
      columns: ["bank_account_id"]
isOneToOne: false
      referencedRelation: "v_bank_balances"
      referencedColumns: ["bank_account_id"]
    },{
      foreignKeyName: "statement_lines_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "statement_imports"
      referencedColumns: ["id"]
    }
                  ]
                },"title_installments": {
                  Row: {
                    "amount": number,"amount_settled": number,"barcode": string | null,"boleto_ref": string | null,"discount": number,"due_date": string,"expected_date": string | null,"fee_anticipation_expected": number,"fee_expected": number,"fine": number,"id": string,"interest": number,"n": number,"org_id": string,"pix_emv": string | null,"status": Database["fin"]['Enums']["title_status"],"title_id": string,"updated_at": string
                  }
                  Insert: {
                    "amount": number,"amount_settled"?: number,"barcode"?: string | null,"boleto_ref"?: string | null,"discount"?: number,"due_date": string,"expected_date"?: string | null,"fee_anticipation_expected"?: number,"fee_expected"?: number,"fine"?: number,"id"?: string,"interest"?: number,"n": number,"org_id": string,"pix_emv"?: string | null,"status"?: Database["fin"]['Enums']["title_status"],"title_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"amount_settled"?: number,"barcode"?: string | null,"boleto_ref"?: string | null,"discount"?: number,"due_date"?: string,"expected_date"?: string | null,"fee_anticipation_expected"?: number,"fee_expected"?: number,"fine"?: number,"id"?: string,"interest"?: number,"n"?: number,"org_id"?: string,"pix_emv"?: string | null,"status"?: Database["fin"]['Enums']["title_status"],"title_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "title_installments_title_id_fkey"
      columns: ["title_id"]
isOneToOne: false
      referencedRelation: "titles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "title_installments_title_id_fkey"
      columns: ["title_id"]
isOneToOne: false
      referencedRelation: "v_open_installments"
      referencedColumns: ["title_id"]
    }
                  ]
                },"title_lines": {
                  Row: {
                    "amount": number,"chart_account_id": string,"cost_center_id": string | null,"id": string,"memo": string | null,"org_id": string,"title_id": string
                  }
                  Insert: {
                    "amount": number,"chart_account_id": string,"cost_center_id"?: string | null,"id"?: string,"memo"?: string | null,"org_id": string,"title_id": string
                  }
                  Update: {
                    "amount"?: number,"chart_account_id"?: string,"cost_center_id"?: string | null,"id"?: string,"memo"?: string | null,"org_id"?: string,"title_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "title_lines_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "title_lines_title_id_fkey"
      columns: ["title_id"]
isOneToOne: false
      referencedRelation: "titles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "title_lines_title_id_fkey"
      columns: ["title_id"]
isOneToOne: false
      referencedRelation: "v_open_installments"
      referencedColumns: ["title_id"]
    }
                  ]
                },"titles": {
                  Row: {
                    "accrual_entry_id": string | null,"accrual_mode": string,"approval_status": string,"approved_at": string | null,"approved_by": string | null,"chart_account_id": string | null,"competence_date": string,"control_account_id": string | null,"cost_center_id": string | null,"created_at": string,"created_by": string | null,"custom_fields": NonNullable<Json>,"description": string,"direction": Database["fin"]['Enums']["title_direction"],"document_kind": string | null,"document_number": string | null,"id": string,"issue_date": string,"legal_entity_id": string,"number": string,"org_id": string,"origin_id": string | null,"origin_type": string,"party_id": string | null,"status": Database["fin"]['Enums']["title_status"],"store_id": string | null,"tags": (string)[],"total_amount": number,"updated_at": string
                  }
                  Insert: {
                    "accrual_entry_id"?: string | null,"accrual_mode"?: string,"approval_status"?: string,"approved_at"?: string | null,"approved_by"?: string | null,"chart_account_id"?: string | null,"competence_date"?: string,"control_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"custom_fields"?: NonNullable<Json>,"description": string,"direction": Database["fin"]['Enums']["title_direction"],"document_kind"?: string | null,"document_number"?: string | null,"id"?: string,"issue_date"?: string,"legal_entity_id": string,"number": string,"org_id": string,"origin_id"?: string | null,"origin_type"?: string,"party_id"?: string | null,"status"?: Database["fin"]['Enums']["title_status"],"store_id"?: string | null,"tags"?: (string)[],"total_amount": number,"updated_at"?: string
                  }
                  Update: {
                    "accrual_entry_id"?: string | null,"accrual_mode"?: string,"approval_status"?: string,"approved_at"?: string | null,"approved_by"?: string | null,"chart_account_id"?: string | null,"competence_date"?: string,"control_account_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"custom_fields"?: NonNullable<Json>,"description"?: string,"direction"?: Database["fin"]['Enums']["title_direction"],"document_kind"?: string | null,"document_number"?: string | null,"id"?: string,"issue_date"?: string,"legal_entity_id"?: string,"number"?: string,"org_id"?: string,"origin_id"?: string | null,"origin_type"?: string,"party_id"?: string | null,"status"?: Database["fin"]['Enums']["title_status"],"store_id"?: string | null,"tags"?: (string)[],"total_amount"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "titles_accrual_entry_id_fkey"
      columns: ["accrual_entry_id"]
isOneToOne: false
      referencedRelation: "journal_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "titles_chart_account_id_fkey"
      columns: ["chart_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "titles_control_account_id_fkey"
      columns: ["control_account_id"]
isOneToOne: false
      referencedRelation: "chart_accounts"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_bank_balances": {
                  Row: {
                    "balance": number | null,"bank_account_id": string | null,"bank_code": string | null,"kind": string | null,"legal_entity_id": string | null,"name": string | null,"org_id": string | null,"unreconciled_amount": number | null,"unreconciled_count": number | null
                  }
                  Relationships: [
                    
                  ]
                },"v_fee_audit": {
                  Row: {
                    "description": string | null,"fee_charged": number | null,"fee_expected": number | null,"gross": number | null,"installment_id": string | null,"org_id": string | null,"settled_on": string | null,"settlement_id": string | null,"settlement_number": string | null,"title_number": string | null,"variance": number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "settlement_lines_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "title_installments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "settlement_lines_installment_id_fkey"
      columns: ["installment_id"]
isOneToOne: false
      referencedRelation: "v_open_installments"
      referencedColumns: ["installment_id"]
    }
                  ]
                },"v_open_installments": {
                  Row: {
                    "amount": number | null,"amount_settled": number | null,"approval_status": string | null,"balance": number | null,"cost_center_id": string | null,"days_overdue": number | null,"description": string | null,"direction": Database["fin"]['Enums']["title_direction"] | null,"document_kind": string | null,"document_number": string | null,"due_date": string | null,"expected_date": string | null,"fee_anticipation_expected": number | null,"fee_expected": number | null,"installment_id": string | null,"legal_entity_id": string | null,"n": number | null,"org_id": string | null,"origin_type": string | null,"party_id": string | null,"party_name": string | null,"status": Database["fin"]['Enums']["title_status"] | null,"store_id": string | null,"title_id": string | null,"title_number": string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "account_ledger":
{ Args: { "p_account": string,"p_entity"?: string,"p_from": string,"p_to": string }; Returns: {
              "cost_center_code": string,"credit": number,"debit": number,"description": string,"entry_date": string,"entry_id": string,"entry_number": string,"kind": string,"memo": string,"running": number
            }[]
                           },
"acquirer_audit":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"apply_recon_rules":
{ Args: { "p_bank_account": string }; Returns: number
                           },
"approve_title":
{ Args: { "p_title": string }; Returns: undefined
                           },
"auto_match":
{ Args: { "p_bank_account": string,"p_days"?: number }; Returns: number
                           },
"budget_vs_actual":
{ Args: { "p_budget": string,"p_from": string,"p_to": string }; Returns: {
              "account_id": string,"actual": number,"budget": number,"code": string,"grp": Database["fin"]['Enums']["account_group"],"name": string
            }[]
                           },
"cancel_title":
{ Args: { "p_reason": string,"p_title": string }; Returns: undefined
                           },
"cash_flow":
{ Args: { "p_bank"?: string,"p_entity"?: string,"p_from": string,"p_to": string }; Returns: {
              "balance": number,"day": string,"projected_in": number,"projected_out": number,"realized_in": number,"realized_out": number
            }[]
                           },
"classify_statement_line":
{ Args: { "p": Json,"p_line": string }; Returns: string
                           },
"close_month":
{ Args: { "p_competence": string,"p_entity": string,"p_force"?: boolean }; Returns: undefined
                           },
"closing_checklist":
{ Args: { "p_competence": string,"p_entity": string }; Returns: {
              "detail": string,"href": string,"key": string,"label": string,"n": number,"status": string
            }[]
                           },
"create_title":
{ Args: { "p": Json }; Returns: {
              "accrual_entry_id": string | null,
"accrual_mode": string,
"approval_status": string,
"approved_at": string | null,
"approved_by": string | null,
"chart_account_id": string | null,
"competence_date": string,
"control_account_id": string | null,
"cost_center_id": string | null,
"created_at": string,
"created_by": string | null,
"custom_fields": NonNullable<Json>,
"description": string,
"direction": Database["fin"]['Enums']["title_direction"],
"document_kind": string | null,
"document_number": string | null,
"id": string,
"issue_date": string,
"legal_entity_id": string,
"number": string,
"org_id": string,
"origin_id": string | null,
"origin_type": string,
"party_id": string | null,
"status": Database["fin"]['Enums']["title_status"],
"store_id": string | null,
"tags": (string)[],
"total_amount": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "titles"
        isOneToOne: true
        isSetofReturn: false
      } },
"dre":
{ Args: { "p_cost_centers"?: (string)[],"p_entity"?: string,"p_from": string,"p_ledger"?: string,"p_to": string }; Returns: {
              "amount": number,"code": string,"is_subtotal": boolean,"name": string,"pos": number,"sign": number
            }[]
                           },
"expected_fee_rate":
{ Args: { "p_acquirer": string,"p_installments": number,"p_method": string,"p_mode": string,"p_on"?: string,"p_org": string }; Returns: number
                           },
"generate_contract_schedule":
{ Args: { "p_contract": string }; Returns: number
                           },
"ignore_statement_line":
{ Args: { "p_line": string,"p_reason": string }; Returns: undefined
                           },
"import_acquirer":
{ Args: { "p": Json }; Returns: Json
                           },
"import_statement":
{ Args: { "p": Json }; Returns: Json
                           },
"link_statement_line":
{ Args: { "p_line": string,"p_tx": string }; Returns: undefined
                           },
"post_cash_movement":
{ Args: { "p": Json }; Returns: string
                           },
"post_manual_entry":
{ Args: { "p": Json }; Returns: string
                           },
"reopen_month":
{ Args: { "p_competence": string,"p_entity": string,"p_reason": string }; Returns: undefined
                           },
"report_cross_gaps":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"reschedule_installment":
{ Args: { "p_barcode"?: string,"p_due_date": string,"p_installment": string }; Returns: undefined
                           },
"restore_statement_line":
{ Args: { "p_line": string }; Returns: undefined
                           },
"reverse_allocation_batch":
{ Args: { "p_batch": string,"p_reason": string }; Returns: undefined
                           },
"reverse_settlement":
{ Args: { "p_reason": string,"p_settlement": string }; Returns: undefined
                           },
"run_allocation_batch":
{ Args: { "p_competence": string,"p_entity": string }; Returns: {
              "competence": string,
"created_at": string,
"created_by": string | null,
"detail": NonNullable<Json>,
"entry_ids": (string)[],
"id": string,
"legal_entity_id": string,
"org_id": string,
"reversal_reason": string | null,
"reversed_at": string | null,
"reversed_by": string | null,
"status": string,
"total": number
            }
                          SetofOptions: {
        from: "*"
        to: "allocation_batches"
        isOneToOne: true
        isSetofReturn: false
      } },
"run_recurring":
{ Args: { "p_until"?: string }; Returns: number
                           },
"save_budget":
{ Args: { "p": Json }; Returns: {
              "created_at": string,
"created_by": string | null,
"id": string,
"legal_entity_id": string,
"name": string,
"notes": string | null,
"org_id": string,
"scenario": string,
"status": string,
"version": number,
"year": number
            }
                          SetofOptions: {
        from: "*"
        to: "budgets"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_recurring":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"allocation_template_id": string | null,
"amount": number,
"auto_approve": boolean,
"chart_account_id": string | null,
"cost_center_id": string | null,
"created_at": string,
"created_by": string | null,
"day_of_month": number,
"description": string,
"direction": Database["fin"]['Enums']["title_direction"],
"document_kind": string,
"end_date": string | null,
"id": string,
"legal_entity_id": string,
"next_run": string,
"notes": string | null,
"org_id": string,
"party_id": string | null,
"start_date": string,
"store_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "recurring_templates"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_budget_status":
{ Args: { "p_budget": string,"p_status": string }; Returns: undefined
                           },
"set_period_status":
{ Args: { "p_competence": string,"p_entity": string,"p_notes"?: string,"p_status": string }; Returns: undefined
                           },
"settle":
{ Args: { "p": Json }; Returns: {
              "amount": number,
"bank_account_id": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"direction": Database["fin"]['Enums']["title_direction"],
"id": string,
"idempotency_key": string | null,
"legal_entity_id": string,
"method": string,
"number": string,
"org_id": string,
"party_id": string | null,
"reference": string | null,
"reversal_reason": string | null,
"reversed_at": string | null,
"reversed_by": string | null,
"settled_on": string,
"status": string
            }
                          SetofOptions: {
        from: "*"
        to: "settlements"
        isOneToOne: true
        isSetofReturn: false
      } },
"settle_acquirer_payout":
{ Args: { "p_bank_account"?: string,"p_payout": string }; Returns: {
              "amount": number,
"bank_account_id": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"direction": Database["fin"]['Enums']["title_direction"],
"id": string,
"idempotency_key": string | null,
"legal_entity_id": string,
"method": string,
"number": string,
"org_id": string,
"party_id": string | null,
"reference": string | null,
"reversal_reason": string | null,
"reversed_at": string | null,
"reversed_by": string | null,
"settled_on": string,
"status": string
            }
                          SetofOptions: {
        from: "*"
        to: "settlements"
        isOneToOne: true
        isSetofReturn: false
      } },
"settle_installment":
{ Args: { "p_amount"?: number,"p_installment": string }; Returns: undefined
                           },
"split_by_template":
{ Args: { "p_amount": number,"p_template": string }; Returns: {
              "amount": number,"cost_center_id": string
            }[]
                           },
"transfer":
{ Args: { "p": Json }; Returns: string
                           },
"trial_balance":
{ Args: { "p_entity"?: string,"p_from": string,"p_ledger"?: string,"p_to": string }; Returns: {
              "account_id": string,"closing": number,"code": string,"credit": number,"debit": number,"grp": Database["fin"]['Enums']["account_group"],"name": string,"nature": string,"opening": number
            }[]
                           },
"unlink_statement_line":
{ Args: { "p_line": string }; Returns: undefined
                           }
          }
          Enums: {
            "account_group": "ASSET"|"LIABILITY"|"EQUITY"|"REVENUE"|"DEDUCTION"|"COGS"|"EXPENSE"|"FINANCIAL","title_direction": "RECEIVABLE"|"PAYABLE","title_status": "OPEN"|"PARTIAL"|"SETTLED"|"CANCELLED"|"RENEGOTIATED"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"fiscal": {
          Tables: {
            "dfe_sync_state": {
                  Row: {
                    "last_error": string | null,"last_found": number,"last_run_at": string | null,"last_version": number,"legal_entity_id": string,"org_id": string
                  }
                  Insert: {
                    "last_error"?: string | null,"last_found"?: number,"last_run_at"?: string | null,"last_version"?: number,"legal_entity_id": string,"org_id": string
                  }
                  Update: {
                    "last_error"?: string | null,"last_found"?: number,"last_run_at"?: string | null,"last_version"?: number,"legal_entity_id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"document_installments": {
                  Row: {
                    "amount": number,"document_id": string,"due_date": string,"id": string,"n_dup": string | null,"org_id": string
                  }
                  Insert: {
                    "amount": number,"document_id": string,"due_date": string,"id"?: string,"n_dup"?: string | null,"org_id": string
                  }
                  Update: {
                    "amount"?: number,"document_id"?: string,"due_date"?: string,"id"?: string,"n_dup"?: string | null,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_installments_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id"]
    }
                  ]
                },"document_items": {
                  Row: {
                    "cean": string | null,"cest": string | null,"cfop": string | null,"cprod": string | null,"csosn": string | null,"cst": string | null,"document_id": string,"id": string,"n_item": number,"ncm": string | null,"org_id": string,"qcom": number | null,"taxes": NonNullable<Json>,"ucom": string | null,"variant_id": string | null,"vdesc": number,"vfrete": number,"vicmsst": number,"vipi": number,"voutro": number,"vprod": number | null,"vseg": number,"vuncom": number | null,"xprod": string | null
                  }
                  Insert: {
                    "cean"?: string | null,"cest"?: string | null,"cfop"?: string | null,"cprod"?: string | null,"csosn"?: string | null,"cst"?: string | null,"document_id": string,"id"?: string,"n_item": number,"ncm"?: string | null,"org_id": string,"qcom"?: number | null,"taxes"?: NonNullable<Json>,"ucom"?: string | null,"variant_id"?: string | null,"vdesc"?: number,"vfrete"?: number,"vicmsst"?: number,"vipi"?: number,"voutro"?: number,"vprod"?: number | null,"vseg"?: number,"vuncom"?: number | null,"xprod"?: string | null
                  }
                  Update: {
                    "cean"?: string | null,"cest"?: string | null,"cfop"?: string | null,"cprod"?: string | null,"csosn"?: string | null,"cst"?: string | null,"document_id"?: string,"id"?: string,"n_item"?: number,"ncm"?: string | null,"org_id"?: string,"qcom"?: number | null,"taxes"?: NonNullable<Json>,"ucom"?: string | null,"variant_id"?: string | null,"vdesc"?: number,"vfrete"?: number,"vicmsst"?: number,"vipi"?: number,"voutro"?: number,"vprod"?: number | null,"vseg"?: number,"vuncom"?: number | null,"xprod"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "document_items_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id"]
    }
                  ]
                },"documents": {
                  Row: {
                    "access_key": string | null,"cfop_main": string | null,"counterpart_cnpj": string | null,"counterpart_name": string | null,"counterpart_party_id": string | null,"created_at": string,"created_by": string | null,"danfe_path": string | null,"direction": string,"events": NonNullable<Json>,"fin_nfe": number,"id": string,"idempotency_key": string | null,"issue_at": string | null,"legal_entity_id": string,"model": string,"number": number | null,"operation_nature": string | null,"order_id": string | null,"org_id": string,"protocol": string | null,"provider_ref": string | null,"receipt_id": string | null,"referenced_keys": (string)[],"return_id": string | null,"sefaz_code": string | null,"sefaz_msg": string | null,"series": number | null,"status": string,"totals": NonNullable<Json>,"transfer_id": string | null,"updated_at": string,"xml": string | null,"xml_path": string | null
                  }
                  Insert: {
                    "access_key"?: string | null,"cfop_main"?: string | null,"counterpart_cnpj"?: string | null,"counterpart_name"?: string | null,"counterpart_party_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"danfe_path"?: string | null,"direction": string,"events"?: NonNullable<Json>,"fin_nfe"?: number,"id"?: string,"idempotency_key"?: string | null,"issue_at"?: string | null,"legal_entity_id": string,"model": string,"number"?: number | null,"operation_nature"?: string | null,"order_id"?: string | null,"org_id": string,"protocol"?: string | null,"provider_ref"?: string | null,"receipt_id"?: string | null,"referenced_keys"?: (string)[],"return_id"?: string | null,"sefaz_code"?: string | null,"sefaz_msg"?: string | null,"series"?: number | null,"status"?: string,"totals"?: NonNullable<Json>,"transfer_id"?: string | null,"updated_at"?: string,"xml"?: string | null,"xml_path"?: string | null
                  }
                  Update: {
                    "access_key"?: string | null,"cfop_main"?: string | null,"counterpart_cnpj"?: string | null,"counterpart_name"?: string | null,"counterpart_party_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"danfe_path"?: string | null,"direction"?: string,"events"?: NonNullable<Json>,"fin_nfe"?: number,"id"?: string,"idempotency_key"?: string | null,"issue_at"?: string | null,"legal_entity_id"?: string,"model"?: string,"number"?: number | null,"operation_nature"?: string | null,"order_id"?: string | null,"org_id"?: string,"protocol"?: string | null,"provider_ref"?: string | null,"receipt_id"?: string | null,"referenced_keys"?: (string)[],"return_id"?: string | null,"sefaz_code"?: string | null,"sefaz_msg"?: string | null,"series"?: number | null,"status"?: string,"totals"?: NonNullable<Json>,"transfer_id"?: string | null,"updated_at"?: string,"xml"?: string | null,"xml_path"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "documents_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "v_uninvoiced_orders"
      referencedColumns: ["order_id"]
    }
                  ]
                },"esocial_events": {
                  Row: {
                    "competence": string | null,"created_at": string,"event": string,"id": string,"legal_entity_id": string,"org_id": string,"payload": NonNullable<Json>,"reference_id": string | null,"reference_type": string | null,"status": string
                  }
                  Insert: {
                    "competence"?: string | null,"created_at"?: string,"event": string,"id"?: string,"legal_entity_id": string,"org_id": string,"payload"?: NonNullable<Json>,"reference_id"?: string | null,"reference_type"?: string | null,"status"?: string
                  }
                  Update: {
                    "competence"?: string | null,"created_at"?: string,"event"?: string,"id"?: string,"legal_entity_id"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"reference_id"?: string | null,"reference_type"?: string | null,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                },"inbound_dfe": {
                  Row: {
                    "access_key": string,"amount": number | null,"created_at": string,"document_id": string | null,"id": string,"issue_at": string | null,"issuer_cnpj": string | null,"issuer_name": string | null,"last_error": string | null,"legal_entity_id": string,"manifest_reason": string | null,"manifest_requested": string | null,"manifest_requested_by": string | null,"manifest_status": string,"nsu": string | null,"org_id": string,"updated_at": string,"xml": string | null,"xml_downloaded": boolean
                  }
                  Insert: {
                    "access_key": string,"amount"?: number | null,"created_at"?: string,"document_id"?: string | null,"id"?: string,"issue_at"?: string | null,"issuer_cnpj"?: string | null,"issuer_name"?: string | null,"last_error"?: string | null,"legal_entity_id": string,"manifest_reason"?: string | null,"manifest_requested"?: string | null,"manifest_requested_by"?: string | null,"manifest_status"?: string,"nsu"?: string | null,"org_id": string,"updated_at"?: string,"xml"?: string | null,"xml_downloaded"?: boolean
                  }
                  Update: {
                    "access_key"?: string,"amount"?: number | null,"created_at"?: string,"document_id"?: string | null,"id"?: string,"issue_at"?: string | null,"issuer_cnpj"?: string | null,"issuer_name"?: string | null,"last_error"?: string | null,"legal_entity_id"?: string,"manifest_reason"?: string | null,"manifest_requested"?: string | null,"manifest_requested_by"?: string | null,"manifest_status"?: string,"nsu"?: string | null,"org_id"?: string,"updated_at"?: string,"xml"?: string | null,"xml_downloaded"?: boolean
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbound_dfe_document_id_fkey"
      columns: ["document_id"]
isOneToOne: false
      referencedRelation: "documents"
      referencedColumns: ["id"]
    }
                  ]
                },"obligations": {
                  Row: {
                    "amount": number,"competence": string,"created_at": string,"due_date": string,"id": string,"kind": string,"legal_entity_id": string,"notes": string | null,"org_id": string,"source_id": string | null,"source_type": string | null,"status": string,"title_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "amount"?: number,"competence": string,"created_at"?: string,"due_date": string,"id"?: string,"kind": string,"legal_entity_id": string,"notes"?: string | null,"org_id": string,"source_id"?: string | null,"source_type"?: string | null,"status"?: string,"title_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "amount"?: number,"competence"?: string,"created_at"?: string,"due_date"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"notes"?: string | null,"org_id"?: string,"source_id"?: string | null,"source_type"?: string | null,"status"?: string,"title_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"simples_brackets": {
                  Row: {
                    "annex": string,"bracket": number,"deduction": number,"icms_share": number | null,"id": string,"max_rbt12": number,"nominal_rate": number,"valid_from": string
                  }
                  Insert: {
                    "annex": string,"bracket": number,"deduction": number,"icms_share"?: number | null,"id"?: string,"max_rbt12": number,"nominal_rate": number,"valid_from"?: string
                  }
                  Update: {
                    "annex"?: string,"bracket"?: number,"deduction"?: number,"icms_share"?: number | null,"id"?: string,"max_rbt12"?: number,"nominal_rate"?: number,"valid_from"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tax_periods": {
                  Row: {
                    "competence": string,"created_at": string,"created_by": string | null,"das_estimated": number,"id": string,"legal_entity_id": string,"org_id": string,"rate1": number,"rate3": number,"rbt12": number,"rbt12_method": string,"returns_amount": number,"revenue_annex1": number,"revenue_annex3": number,"status": string,"title_id": string | null
                  }
                  Insert: {
                    "competence": string,"created_at"?: string,"created_by"?: string | null,"das_estimated"?: number,"id"?: string,"legal_entity_id": string,"org_id": string,"rate1"?: number,"rate3"?: number,"rbt12"?: number,"rbt12_method": string,"returns_amount"?: number,"revenue_annex1"?: number,"revenue_annex3"?: number,"status"?: string,"title_id"?: string | null
                  }
                  Update: {
                    "competence"?: string,"created_at"?: string,"created_by"?: string | null,"das_estimated"?: number,"id"?: string,"legal_entity_id"?: string,"org_id"?: string,"rate1"?: number,"rate3"?: number,"rbt12"?: number,"rbt12_method"?: string,"returns_amount"?: number,"revenue_annex1"?: number,"revenue_annex3"?: number,"status"?: string,"title_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "v_uninvoiced_orders": {
                  Row: {
                    "channel": Database["sales"]['Enums']["channel"] | null,"created_at": string | null,"number": string | null,"order_id": string | null,"org_id": string | null,"party_id": string | null,"status": Database["sales"]['Enums']["order_status"] | null,"store_id": string | null,"total": number | null
                  }
                  Insert: {
                           "channel"?: Database["sales"]['Enums']["channel"] | null,"created_at"?: string | null,"number"?: string | null,"order_id"?: string | null,"org_id"?: string | null,"party_id"?: string | null,"status"?: Database["sales"]['Enums']["order_status"] | null,"store_id"?: string | null,"total"?: number | null
                         }
                        Update: {
                           "channel"?: Database["sales"]['Enums']["channel"] | null,"created_at"?: string | null,"number"?: string | null,"order_id"?: string | null,"org_id"?: string | null,"party_id"?: string | null,"status"?: Database["sales"]['Enums']["order_status"] | null,"store_id"?: string | null,"total"?: number | null
                         }
                        Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "dfe_mark":
{ Args: { "p_error"?: string,"p_id": string,"p_status": string,"p_xml"?: string }; Returns: undefined
                           },
"dfe_set_state":
{ Args: { "p_entity": string,"p_error"?: string,"p_found": number,"p_org": string,"p_version": number }; Returns: undefined
                           },
"dfe_upsert":
{ Args: { "p_entity": string,"p_items": Json,"p_org": string }; Returns: number
                           },
"emission_payload":
{ Args: { "p_order": string,"p_purpose"?: string }; Returns: Json
                           },
"nfe_key_dv":
{ Args: { "p_key43": string }; Returns: number
                           },
"nfe_key_valid":
{ Args: { "p_key": string }; Returns: boolean
                           },
"parse_nfe":
{ Args: { "p_xml": string }; Returns: Json
                           },
"post_das":
{ Args: { "p_competence": string,"p_entity": string }; Returns: {
              "competence": string,
"created_at": string,
"created_by": string | null,
"das_estimated": number,
"id": string,
"legal_entity_id": string,
"org_id": string,
"rate1": number,
"rate3": number,
"rbt12": number,
"rbt12_method": string,
"returns_amount": number,
"revenue_annex1": number,
"revenue_annex3": number,
"status": string,
"title_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "tax_periods"
        isOneToOne: true
        isSetofReturn: false
      } },
"record_cancellation":
{ Args: { "p": Json,"p_document": string }; Returns: undefined
                           },
"record_document_event":
{ Args: { "p_document": string,"p_event": Json }; Returns: undefined
                           },
"record_emission":
{ Args: { "p": Json }; Returns: string
                           },
"request_cancellation":
{ Args: { "p_document": string,"p_reason": string }; Returns: undefined
                           },
"request_dfe_sync":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"request_emission":
{ Args: { "p_order": string }; Returns: undefined
                           },
"request_manifest":
{ Args: { "p_id": string,"p_reason"?: string,"p_type": string }; Returns: {
              "access_key": string,
"amount": number | null,
"created_at": string,
"document_id": string | null,
"id": string,
"issue_at": string | null,
"issuer_cnpj": string | null,
"issuer_name": string | null,
"last_error": string | null,
"legal_entity_id": string,
"manifest_reason": string | null,
"manifest_requested": string | null,
"manifest_requested_by": string | null,
"manifest_status": string,
"nsu": string | null,
"org_id": string,
"updated_at": string,
"xml": string | null,
"xml_downloaded": boolean
            }
                          SetofOptions: {
        from: "*"
        to: "inbound_dfe"
        isOneToOne: true
        isSetofReturn: false
      } },
"simples_calc":
{ Args: { "p_competence": string,"p_entity": string }; Returns: {
              "das": number,"rate1": number,"rate3": number,"rbt12": number,"rbt12_method": string,"returns_amount": number,"revenue_annex1": number,"revenue_annex3": number
            }[]
                           },
"simples_effective_rate":
{ Args: { "p_annex": string,"p_rbt12": number }; Returns: number
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"hr": {
          Tables: {
            "benefit_types": {
                  Row: {
                    "active": boolean,"calc": string,"code": string,"employee_share_fixed": number,"employee_share_pct": number,"expense_role": string,"id": string,"kind": string,"name": string,"org_id": string,"pay_day": number | null,"share_base": string,"supplier_party_id": string | null,"taxable": boolean
                  }
                  Insert: {
                    "active"?: boolean,"calc"?: string,"code": string,"employee_share_fixed"?: number,"employee_share_pct"?: number,"expense_role"?: string,"id"?: string,"kind": string,"name": string,"org_id": string,"pay_day"?: number | null,"share_base"?: string,"supplier_party_id"?: string | null,"taxable"?: boolean
                  }
                  Update: {
                    "active"?: boolean,"calc"?: string,"code"?: string,"employee_share_fixed"?: number,"employee_share_pct"?: number,"expense_role"?: string,"id"?: string,"kind"?: string,"name"?: string,"org_id"?: string,"pay_day"?: number | null,"share_base"?: string,"supplier_party_id"?: string | null,"taxable"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"coverage_rules": {
                  Row: {
                    "active": boolean,"end_time": string,"id": string,"label": string,"min_staff": number,"org_id": string,"start_time": string,"store_id": string,"weekday": number
                  }
                  Insert: {
                    "active"?: boolean,"end_time": string,"id"?: string,"label": string,"min_staff"?: number,"org_id": string,"start_time": string,"store_id": string,"weekday": number
                  }
                  Update: {
                    "active"?: boolean,"end_time"?: string,"id"?: string,"label"?: string,"min_staff"?: number,"org_id"?: string,"start_time"?: string,"store_id"?: string,"weekday"?: number
                  }
                  Relationships: [
                    
                  ]
                },"dependents": {
                  Row: {
                    "birth_date": string | null,"cpf": string | null,"created_at": string,"employee_id": string,"family_allowance": boolean,"id": string,"irrf": boolean,"name": string,"org_id": string,"relationship": string
                  }
                  Insert: {
                    "birth_date"?: string | null,"cpf"?: string | null,"created_at"?: string,"employee_id": string,"family_allowance"?: boolean,"id"?: string,"irrf"?: boolean,"name": string,"org_id": string,"relationship"?: string
                  }
                  Update: {
                    "birth_date"?: string | null,"cpf"?: string | null,"created_at"?: string,"employee_id"?: string,"family_allowance"?: boolean,"id"?: string,"irrf"?: boolean,"name"?: string,"org_id"?: string,"relationship"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "dependents_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"employee_benefits": {
                  Row: {
                    "benefit_type_id": string,"employee_id": string,"end_date": string | null,"id": string,"notes": string | null,"org_id": string,"share_pct_override": number | null,"start_date": string,"value": number
                  }
                  Insert: {
                    "benefit_type_id": string,"employee_id": string,"end_date"?: string | null,"id"?: string,"notes"?: string | null,"org_id": string,"share_pct_override"?: number | null,"start_date"?: string,"value": number
                  }
                  Update: {
                    "benefit_type_id"?: string,"employee_id"?: string,"end_date"?: string | null,"id"?: string,"notes"?: string | null,"org_id"?: string,"share_pct_override"?: number | null,"start_date"?: string,"value"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "employee_benefits_benefit_type_id_fkey"
      columns: ["benefit_type_id"]
isOneToOne: false
      referencedRelation: "benefit_types"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "employee_benefits_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"employee_deductions": {
                  Row: {
                    "beneficiary_party_id": string | null,"calc": string,"employee_id": string,"end_date": string | null,"event_code": string,"id": string,"installments_left": number | null,"notes": string | null,"org_id": string,"start_date": string,"value": number
                  }
                  Insert: {
                    "beneficiary_party_id"?: string | null,"calc"?: string,"employee_id": string,"end_date"?: string | null,"event_code": string,"id"?: string,"installments_left"?: number | null,"notes"?: string | null,"org_id": string,"start_date"?: string,"value": number
                  }
                  Update: {
                    "beneficiary_party_id"?: string | null,"calc"?: string,"employee_id"?: string,"end_date"?: string | null,"event_code"?: string,"id"?: string,"installments_left"?: number | null,"notes"?: string | null,"org_id"?: string,"start_date"?: string,"value"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "employee_deductions_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"employee_private": {
                  Row: {
                    "address": NonNullable<Json>,"bank_account": string | null,"bank_agency": string | null,"bank_code": string | null,"cpf": string | null,"ctps": string | null,"education": string | null,"emergency_contact": NonNullable<Json>,"employee_id": string,"marital_status": string | null,"mother_name": string | null,"org_id": string,"pis": string | null,"pix_key": string | null,"rg": string | null,"updated_at": string
                  }
                  Insert: {
                    "address"?: NonNullable<Json>,"bank_account"?: string | null,"bank_agency"?: string | null,"bank_code"?: string | null,"cpf"?: string | null,"ctps"?: string | null,"education"?: string | null,"emergency_contact"?: NonNullable<Json>,"employee_id": string,"marital_status"?: string | null,"mother_name"?: string | null,"org_id": string,"pis"?: string | null,"pix_key"?: string | null,"rg"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "address"?: NonNullable<Json>,"bank_account"?: string | null,"bank_agency"?: string | null,"bank_code"?: string | null,"cpf"?: string | null,"ctps"?: string | null,"education"?: string | null,"emergency_contact"?: NonNullable<Json>,"employee_id"?: string,"marital_status"?: string | null,"mother_name"?: string | null,"org_id"?: string,"pis"?: string | null,"pix_key"?: string | null,"rg"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "employee_private_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: true
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"employees": {
                  Row: {
                    "archived_at": string | null,"cbo": string | null,"commissioned": boolean,"contract_type": string,"cost_center_id": string | null,"created_at": string,"daily_minutes": number,"department": string | null,"experience_days": (number)[],"fgts": boolean,"hire_date": string,"id": string,"job_title": string,"legal_entity_id": string,"member_id": string | null,"notes": string | null,"org_id": string,"party_id": string,"registration": string,"status": string,"store_id": string | null,"termination_date": string | null,"time_bank": boolean,"track_time": boolean,"updated_at": string,"weekly_hours": number,"work_regime": string
                  }
                  Insert: {
                    "archived_at"?: string | null,"cbo"?: string | null,"commissioned"?: boolean,"contract_type": string,"cost_center_id"?: string | null,"created_at"?: string,"daily_minutes"?: number,"department"?: string | null,"experience_days"?: (number)[],"fgts"?: boolean,"hire_date": string,"id"?: string,"job_title": string,"legal_entity_id": string,"member_id"?: string | null,"notes"?: string | null,"org_id": string,"party_id": string,"registration": string,"status"?: string,"store_id"?: string | null,"termination_date"?: string | null,"time_bank"?: boolean,"track_time"?: boolean,"updated_at"?: string,"weekly_hours"?: number,"work_regime"?: string
                  }
                  Update: {
                    "archived_at"?: string | null,"cbo"?: string | null,"commissioned"?: boolean,"contract_type"?: string,"cost_center_id"?: string | null,"created_at"?: string,"daily_minutes"?: number,"department"?: string | null,"experience_days"?: (number)[],"fgts"?: boolean,"hire_date"?: string,"id"?: string,"job_title"?: string,"legal_entity_id"?: string,"member_id"?: string | null,"notes"?: string | null,"org_id"?: string,"party_id"?: string,"registration"?: string,"status"?: string,"store_id"?: string | null,"termination_date"?: string | null,"time_bank"?: boolean,"track_time"?: boolean,"updated_at"?: string,"weekly_hours"?: number,"work_regime"?: string
                  }
                  Relationships: [
                    
                  ]
                },"entity_settings": {
                  Row: {
                    "charge_profile": string,"inss_employer_pct": number,"legal_entity_id": string,"org_id": string,"pay_business_day": number,"rat_pct": number,"third_parties_pct": number,"updated_at": string
                  }
                  Insert: {
                    "charge_profile"?: string,"inss_employer_pct"?: number,"legal_entity_id": string,"org_id": string,"pay_business_day"?: number,"rat_pct"?: number,"third_parties_pct"?: number,"updated_at"?: string
                  }
                  Update: {
                    "charge_profile"?: string,"inss_employer_pct"?: number,"legal_entity_id"?: string,"org_id"?: string,"pay_business_day"?: number,"rat_pct"?: number,"third_parties_pct"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"freelance_jobs": {
                  Row: {
                    "amount": number,"created_at": string,"created_by": string | null,"document_kind": string,"id": string,"kind": string,"legal_entity_id": string,"org_id": string,"party_id": string,"service": string,"store_id": string | null,"title_id": string | null,"work_dates": (string)[]
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"created_by"?: string | null,"document_kind"?: string,"id"?: string,"kind": string,"legal_entity_id": string,"org_id": string,"party_id": string,"service": string,"store_id"?: string | null,"title_id"?: string | null,"work_dates": (string)[]
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"created_by"?: string | null,"document_kind"?: string,"id"?: string,"kind"?: string,"legal_entity_id"?: string,"org_id"?: string,"party_id"?: string,"service"?: string,"store_id"?: string | null,"title_id"?: string | null,"work_dates"?: (string)[]
                  }
                  Relationships: [
                    
                  ]
                },"holidays": {
                  Row: {
                    "created_at": string,"holiday_date": string,"id": string,"name": string,"optional": boolean,"org_id": string,"scope": string,"store_id": string | null,"uf": string | null
                  }
                  Insert: {
                    "created_at"?: string,"holiday_date": string,"id"?: string,"name": string,"optional"?: boolean,"org_id": string,"scope"?: string,"store_id"?: string | null,"uf"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"holiday_date"?: string,"id"?: string,"name"?: string,"optional"?: boolean,"org_id"?: string,"scope"?: string,"store_id"?: string | null,"uf"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"leaves": {
                  Row: {
                    "cid": string | null,"created_at": string,"created_by": string | null,"doc_ref": string | null,"employee_id": string,"end_date": string,"id": string,"inss_leave": boolean,"kind": string,"notes": string | null,"org_id": string,"paid": boolean,"start_date": string
                  }
                  Insert: {
                    "cid"?: string | null,"created_at"?: string,"created_by"?: string | null,"doc_ref"?: string | null,"employee_id": string,"end_date": string,"id"?: string,"inss_leave"?: boolean,"kind": string,"notes"?: string | null,"org_id": string,"paid"?: boolean,"start_date": string
                  }
                  Update: {
                    "cid"?: string | null,"created_at"?: string,"created_by"?: string | null,"doc_ref"?: string | null,"employee_id"?: string,"end_date"?: string,"id"?: string,"inss_leave"?: boolean,"kind"?: string,"notes"?: string | null,"org_id"?: string,"paid"?: boolean,"start_date"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "leaves_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"medical_exams": {
                  Row: {
                    "employee_id": string,"exam_date": string,"id": string,"kind": string,"notes": string | null,"org_id": string,"result": string | null,"valid_until": string | null
                  }
                  Insert: {
                    "employee_id": string,"exam_date": string,"id"?: string,"kind": string,"notes"?: string | null,"org_id": string,"result"?: string | null,"valid_until"?: string | null
                  }
                  Update: {
                    "employee_id"?: string,"exam_date"?: string,"id"?: string,"kind"?: string,"notes"?: string | null,"org_id"?: string,"result"?: string | null,"valid_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "medical_exams_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"payroll_events": {
                  Row: {
                    "active": boolean,"code": string,"esocial_code": string | null,"expense_role": string | null,"fgts": boolean,"id": string,"inss": boolean,"irrf": boolean,"kind": string,"liability_role": string | null,"name": string,"org_id": string,"vacation_avg": boolean,"variable": boolean
                  }
                  Insert: {
                    "active"?: boolean,"code": string,"esocial_code"?: string | null,"expense_role"?: string | null,"fgts"?: boolean,"id"?: string,"inss"?: boolean,"irrf"?: boolean,"kind": string,"liability_role"?: string | null,"name": string,"org_id": string,"vacation_avg"?: boolean,"variable"?: boolean
                  }
                  Update: {
                    "active"?: boolean,"code"?: string,"esocial_code"?: string | null,"expense_role"?: string | null,"fgts"?: boolean,"id"?: string,"inss"?: boolean,"irrf"?: boolean,"kind"?: string,"liability_role"?: string | null,"name"?: string,"org_id"?: string,"vacation_avg"?: boolean,"variable"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"payroll_runs": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"competence": string,"created_at": string,"created_by": string | null,"description": string | null,"id": string,"journal_entry_id": string | null,"kind": string,"legal_entity_id": string,"notes": string | null,"org_id": string,"pay_date": string | null,"reference_id": string | null,"reference_type": string | null,"source": string,"status": string,"totals": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"competence": string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"kind": string,"legal_entity_id": string,"notes"?: string | null,"org_id": string,"pay_date"?: string | null,"reference_id"?: string | null,"reference_type"?: string | null,"source"?: string,"status"?: string,"totals"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"competence"?: string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"kind"?: string,"legal_entity_id"?: string,"notes"?: string | null,"org_id"?: string,"pay_date"?: string | null,"reference_id"?: string | null,"reference_type"?: string | null,"source"?: string,"status"?: string,"totals"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"payslip_lines": {
                  Row: {
                    "amount": number,"beneficiary_party_id": string | null,"created_at": string,"description": string,"event_code": string,"id": string,"kind": string,"memo": string | null,"org_id": string,"payslip_id": string,"reference": number | null,"source": string,"supplier_party_id": string | null
                  }
                  Insert: {
                    "amount": number,"beneficiary_party_id"?: string | null,"created_at"?: string,"description": string,"event_code": string,"id"?: string,"kind": string,"memo"?: string | null,"org_id": string,"payslip_id": string,"reference"?: number | null,"source"?: string,"supplier_party_id"?: string | null
                  }
                  Update: {
                    "amount"?: number,"beneficiary_party_id"?: string | null,"created_at"?: string,"description"?: string,"event_code"?: string,"id"?: string,"kind"?: string,"memo"?: string | null,"org_id"?: string,"payslip_id"?: string,"reference"?: number | null,"source"?: string,"supplier_party_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payslip_lines_payslip_id_fkey"
      columns: ["payslip_id"]
isOneToOne: false
      referencedRelation: "payslips"
      referencedColumns: ["id"]
    }
                  ]
                },"payslips": {
                  Row: {
                    "base_group": string,"deductions": number,"dependents": number,"employee_id": string,"employer_cost": number,"fgts": number,"fgts_base": number,"gross": number,"id": string,"inss": number,"inss_base": number,"irrf": number,"irrf_base": number,"net": number,"notes": string | null,"org_id": string,"run_id": string,"status": string,"title_id": string | null
                  }
                  Insert: {
                    "base_group"?: string,"deductions"?: number,"dependents"?: number,"employee_id": string,"employer_cost"?: number,"fgts"?: number,"fgts_base"?: number,"gross"?: number,"id"?: string,"inss"?: number,"inss_base"?: number,"irrf"?: number,"irrf_base"?: number,"net"?: number,"notes"?: string | null,"org_id": string,"run_id": string,"status"?: string,"title_id"?: string | null
                  }
                  Update: {
                    "base_group"?: string,"deductions"?: number,"dependents"?: number,"employee_id"?: string,"employer_cost"?: number,"fgts"?: number,"fgts_base"?: number,"gross"?: number,"id"?: string,"inss"?: number,"inss_base"?: number,"irrf"?: number,"irrf_base"?: number,"net"?: number,"notes"?: string | null,"org_id"?: string,"run_id"?: string,"status"?: string,"title_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payslips_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payslips_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "payroll_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"provision_runs": {
                  Row: {
                    "competence": string,"created_at": string,"created_by": string | null,"id": string,"journal_entry_id": string | null,"legal_entity_id": string,"org_id": string,"totals": NonNullable<Json>
                  }
                  Insert: {
                    "competence": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"legal_entity_id": string,"org_id": string,"totals"?: NonNullable<Json>
                  }
                  Update: {
                    "competence"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"journal_entry_id"?: string | null,"legal_entity_id"?: string,"org_id"?: string,"totals"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"provisions": {
                  Row: {
                    "amount": number,"competence": string,"created_at": string,"employee_id": string,"id": number,"kind": string,"org_id": string,"source_id": string | null,"source_type": string | null
                  }
                  Insert: {
                    "amount": number,"competence": string,"created_at"?: string,"employee_id": string,"id"?: never,"kind": string,"org_id": string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Update: {
                    "amount"?: number,"competence"?: string,"created_at"?: string,"employee_id"?: string,"id"?: never,"kind"?: string,"org_id"?: string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "provisions_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"roster": {
                  Row: {
                    "break_minutes": number,"employee_id": string,"end_time": string | null,"id": string,"kind": string,"notes": string | null,"org_id": string,"shift_id": string | null,"start_time": string | null,"status": string,"store_id": string,"updated_at": string,"updated_by": string | null,"work_date": string
                  }
                  Insert: {
                    "break_minutes"?: number,"employee_id": string,"end_time"?: string | null,"id"?: string,"kind"?: string,"notes"?: string | null,"org_id": string,"shift_id"?: string | null,"start_time"?: string | null,"status"?: string,"store_id": string,"updated_at"?: string,"updated_by"?: string | null,"work_date": string
                  }
                  Update: {
                    "break_minutes"?: number,"employee_id"?: string,"end_time"?: string | null,"id"?: string,"kind"?: string,"notes"?: string | null,"org_id"?: string,"shift_id"?: string | null,"start_time"?: string | null,"status"?: string,"store_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"work_date"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roster_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "roster_shift_id_fkey"
      columns: ["shift_id"]
isOneToOne: false
      referencedRelation: "shift_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"salary_history": {
                  Row: {
                    "amount": number,"created_at": string,"created_by": string | null,"effective_from": string,"employee_id": string,"id": string,"org_id": string,"reason": string | null,"unit": string
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"created_by"?: string | null,"effective_from": string,"employee_id": string,"id"?: string,"org_id": string,"reason"?: string | null,"unit"?: string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"created_by"?: string | null,"effective_from"?: string,"employee_id"?: string,"id"?: string,"org_id"?: string,"reason"?: string | null,"unit"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "salary_history_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"shift_templates": {
                  Row: {
                    "active": boolean,"break_minutes": number,"code": string,"color": string,"end_time": string,"id": string,"name": string,"org_id": string,"start_time": string,"store_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"break_minutes"?: number,"code": string,"color"?: string,"end_time": string,"id"?: string,"name": string,"org_id": string,"start_time": string,"store_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"break_minutes"?: number,"code"?: string,"color"?: string,"end_time"?: string,"id"?: string,"name"?: string,"org_id"?: string,"start_time"?: string,"store_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tax_tables": {
                  Row: {
                    "data": NonNullable<Json>,"id": string,"kind": string,"notes": string | null,"source": string | null,"valid_from": string
                  }
                  Insert: {
                    "data": NonNullable<Json>,"id"?: string,"kind": string,"notes"?: string | null,"source"?: string | null,"valid_from": string
                  }
                  Update: {
                    "data"?: NonNullable<Json>,"id"?: string,"kind"?: string,"notes"?: string | null,"source"?: string | null,"valid_from"?: string
                  }
                  Relationships: [
                    
                  ]
                },"terminations": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"computed": NonNullable<Json>,"created_at": string,"created_by": string | null,"employee_id": string,"fgts_balance": number | null,"id": string,"kind": string,"notes": string | null,"notice_days": number | null,"notice_kind": string,"org_id": string,"reason": string | null,"run_id": string | null,"status": string,"termination_date": string,"updated_at": string
                  }
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"computed"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"employee_id": string,"fgts_balance"?: number | null,"id"?: string,"kind": string,"notes"?: string | null,"notice_days"?: number | null,"notice_kind"?: string,"org_id": string,"reason"?: string | null,"run_id"?: string | null,"status"?: string,"termination_date": string,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"computed"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"employee_id"?: string,"fgts_balance"?: number | null,"id"?: string,"kind"?: string,"notes"?: string | null,"notice_days"?: number | null,"notice_kind"?: string,"org_id"?: string,"reason"?: string | null,"run_id"?: string | null,"status"?: string,"termination_date"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "terminations_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "terminations_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "payroll_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"time_bank": {
                  Row: {
                    "created_at": string,"created_by": string | null,"employee_id": string,"id": number,"kind": string,"minutes": number,"note": string | null,"occurred_on": string,"org_id": string,"source_id": string | null,"source_type": string | null
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"employee_id": string,"id"?: never,"kind": string,"minutes": number,"note"?: string | null,"occurred_on": string,"org_id": string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"employee_id"?: string,"id"?: never,"kind"?: string,"minutes"?: number,"note"?: string | null,"occurred_on"?: string,"org_id"?: string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_bank_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"time_entries": {
                  Row: {
                    "approved": boolean,"break_minutes": number,"employee_id": string,"end_time": string,"id": string,"notes": string | null,"org_id": string,"source": string,"start_time": string,"work_date": string
                  }
                  Insert: {
                    "approved"?: boolean,"break_minutes"?: number,"employee_id": string,"end_time": string,"id"?: string,"notes"?: string | null,"org_id": string,"source"?: string,"start_time": string,"work_date": string
                  }
                  Update: {
                    "approved"?: boolean,"break_minutes"?: number,"employee_id"?: string,"end_time"?: string,"id"?: string,"notes"?: string | null,"org_id"?: string,"source"?: string,"start_time"?: string,"work_date"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_entries_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"timesheets": {
                  Row: {
                    "absence_days": number,"bank_delta_min": number,"closed_at": string | null,"closed_by": string | null,"competence": string,"detail": NonNullable<Json>,"dsr_lost_days": number,"employee_id": string,"id": string,"late_min": number,"night_min": number,"org_id": string,"ot100_min": number,"ot50_min": number,"regular_min": number,"status": string
                  }
                  Insert: {
                    "absence_days"?: number,"bank_delta_min"?: number,"closed_at"?: string | null,"closed_by"?: string | null,"competence": string,"detail"?: NonNullable<Json>,"dsr_lost_days"?: number,"employee_id": string,"id"?: string,"late_min"?: number,"night_min"?: number,"org_id": string,"ot100_min"?: number,"ot50_min"?: number,"regular_min"?: number,"status"?: string
                  }
                  Update: {
                    "absence_days"?: number,"bank_delta_min"?: number,"closed_at"?: string | null,"closed_by"?: string | null,"competence"?: string,"detail"?: NonNullable<Json>,"dsr_lost_days"?: number,"employee_id"?: string,"id"?: string,"late_min"?: number,"night_min"?: number,"org_id"?: string,"ot100_min"?: number,"ot50_min"?: number,"regular_min"?: number,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "timesheets_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"vacation_periods": {
                  Row: {
                    "absences": number,"closed_reason": string | null,"concessive_end": string,"days_entitled": number,"employee_id": string,"id": string,"org_id": string,"period_end": string,"period_start": string
                  }
                  Insert: {
                    "absences"?: number,"closed_reason"?: string | null,"concessive_end": string,"days_entitled"?: number,"employee_id": string,"id"?: string,"org_id": string,"period_end": string,"period_start": string
                  }
                  Update: {
                    "absences"?: number,"closed_reason"?: string | null,"concessive_end"?: string,"days_entitled"?: number,"employee_id"?: string,"id"?: string,"org_id"?: string,"period_end"?: string,"period_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vacation_periods_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"vacations": {
                  Row: {
                    "created_at": string,"created_by": string | null,"days": number,"double_pay": boolean,"employee_id": string,"end_date": string,"id": string,"notes": string | null,"org_id": string,"pay_date": string | null,"payslip_id": string | null,"period_id": string,"sell_days": number,"start_date": string,"status": string,"thirteenth_advance": boolean,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"days": number,"double_pay"?: boolean,"employee_id": string,"end_date": string,"id"?: string,"notes"?: string | null,"org_id": string,"pay_date"?: string | null,"payslip_id"?: string | null,"period_id": string,"sell_days"?: number,"start_date": string,"status"?: string,"thirteenth_advance"?: boolean,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"days"?: number,"double_pay"?: boolean,"employee_id"?: string,"end_date"?: string,"id"?: string,"notes"?: string | null,"org_id"?: string,"pay_date"?: string | null,"payslip_id"?: string | null,"period_id"?: string,"sell_days"?: number,"start_date"?: string,"status"?: string,"thirteenth_advance"?: boolean,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "vacations_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vacations_payslip_fk"
      columns: ["payslip_id"]
isOneToOne: false
      referencedRelation: "payslips"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "vacations_period_id_fkey"
      columns: ["period_id"]
isOneToOne: false
      referencedRelation: "v_vacation_balance"
      referencedColumns: ["period_id"]
    },{
      foreignKeyName: "vacations_period_id_fkey"
      columns: ["period_id"]
isOneToOne: false
      referencedRelation: "vacation_periods"
      referencedColumns: ["id"]
    }
                  ]
                },"weekly_patterns": {
                  Row: {
                    "employee_id": string,"id": string,"kind": string,"org_id": string,"shift_id": string | null,"updated_at": string,"weekday": number
                  }
                  Insert: {
                    "employee_id": string,"id"?: string,"kind": string,"org_id": string,"shift_id"?: string | null,"updated_at"?: string,"weekday": number
                  }
                  Update: {
                    "employee_id"?: string,"id"?: string,"kind"?: string,"org_id"?: string,"shift_id"?: string | null,"updated_at"?: string,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "weekly_patterns_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "weekly_patterns_shift_id_fkey"
      columns: ["shift_id"]
isOneToOne: false
      referencedRelation: "shift_templates"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_time_bank_balance": {
                  Row: {
                    "balance_min": number | null,"employee_id": string | null,"org_id": string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_bank_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                },"v_vacation_balance": {
                  Row: {
                    "absences": number | null,"acquired": boolean | null,"concessive_end": string | null,"days_entitled": number | null,"days_left": number | null,"days_to_expire": number | null,"employee_id": string | null,"org_id": string | null,"period_end": string | null,"period_id": string | null,"period_start": string | null,"sold_days": number | null,"used_days": number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "vacation_periods_employee_id_fkey"
      columns: ["employee_id"]
isOneToOne: false
      referencedRelation: "employees"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "accrue_provisions":
{ Args: { "p_competence": string,"p_entity": string }; Returns: {
              "competence": string,
"created_at": string,
"created_by": string | null,
"id": string,
"journal_entry_id": string | null,
"legal_entity_id": string,
"org_id": string,
"totals": NonNullable<Json>
            }
                          SetofOptions: {
        from: "*"
        to: "provision_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"add_leave":
{ Args: { "p": Json }; Returns: {
              "cid": string | null,
"created_at": string,
"created_by": string | null,
"doc_ref": string | null,
"employee_id": string,
"end_date": string,
"id": string,
"inss_leave": boolean,
"kind": string,
"notes": string | null,
"org_id": string,
"paid": boolean,
"start_date": string
            }
                          SetofOptions: {
        from: "*"
        to: "leaves"
        isOneToOne: true
        isSetofReturn: false
      } },
"add_manual_line":
{ Args: { "p_amount": number,"p_code": string,"p_desc"?: string,"p_payslip": string,"p_source"?: string }; Returns: undefined
                           },
"apply_weekly_patterns":
{ Args: { "p_from": string,"p_overwrite"?: boolean,"p_store": string,"p_to": string }; Returns: number
                           },
"approve_run":
{ Args: { "p_run": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"competence": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"id": string,
"journal_entry_id": string | null,
"kind": string,
"legal_entity_id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"reference_id": string | null,
"reference_type": string | null,
"source": string,
"status": string,
"totals": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "payroll_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"approve_termination":
{ Args: { "p_termination": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"computed": NonNullable<Json>,
"created_at": string,
"created_by": string | null,
"employee_id": string,
"fgts_balance": number | null,
"id": string,
"kind": string,
"notes": string | null,
"notice_days": number | null,
"notice_kind": string,
"org_id": string,
"reason": string | null,
"run_id": string | null,
"status": string,
"termination_date": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "terminations"
        isOneToOne: true
        isSetofReturn: false
      } },
"approve_vacation":
{ Args: { "p_vacation": string }; Returns: {
              "created_at": string,
"created_by": string | null,
"days": number,
"double_pay": boolean,
"employee_id": string,
"end_date": string,
"id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"payslip_id": string | null,
"period_id": string,
"sell_days": number,
"start_date": string,
"status": string,
"thirteenth_advance": boolean,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "vacations"
        isOneToOne: true
        isSetofReturn: false
      } },
"calc_inss":
{ Args: { "p_base": number,"p_on": string }; Returns: number
                           },
"calc_inss_prolabore":
{ Args: { "p_base": number,"p_on": string }; Returns: number
                           },
"calc_irrf":
{ Args: { "p_apply_reducer"?: boolean,"p_dependents": number,"p_inss": number,"p_on": string,"p_other_deductions"?: number,"p_taxable": number }; Returns: number
                           },
"calc_run":
{ Args: { "p_run": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"competence": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"id": string,
"journal_entry_id": string | null,
"kind": string,
"legal_entity_id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"reference_id": string | null,
"reference_type": string | null,
"source": string,
"status": string,
"totals": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "payroll_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"cancel_run":
{ Args: { "p_reason"?: string,"p_run": string }; Returns: undefined
                           },
"cancel_termination":
{ Args: { "p_reason"?: string,"p_termination": string }; Returns: undefined
                           },
"cancel_vacation":
{ Args: { "p_reason"?: string,"p_vacation": string }; Returns: undefined
                           },
"change_salary":
{ Args: { "p_amount": number,"p_effective_from": string,"p_employee": string,"p_reason"?: string,"p_unit"?: string }; Returns: undefined
                           },
"close_timesheet":
{ Args: { "p_competence": string,"p_employee": string,"p_force"?: boolean }; Returns: {
              "absence_days": number,
"bank_delta_min": number,
"closed_at": string | null,
"closed_by": string | null,
"competence": string,
"detail": NonNullable<Json>,
"dsr_lost_days": number,
"employee_id": string,
"id": string,
"late_min": number,
"night_min": number,
"org_id": string,
"ot100_min": number,
"ot50_min": number,
"regular_min": number,
"status": string
            }
                          SetofOptions: {
        from: "*"
        to: "timesheets"
        isOneToOne: true
        isSetofReturn: false
      } },
"copy_roster":
{ Args: { "p_days": number,"p_source_from": string,"p_store": string,"p_target_from": string }; Returns: number
                           },
"create_employee":
{ Args: { "p": Json }; Returns: {
              "archived_at": string | null,
"cbo": string | null,
"commissioned": boolean,
"contract_type": string,
"cost_center_id": string | null,
"created_at": string,
"daily_minutes": number,
"department": string | null,
"experience_days": (number)[],
"fgts": boolean,
"hire_date": string,
"id": string,
"job_title": string,
"legal_entity_id": string,
"member_id": string | null,
"notes": string | null,
"org_id": string,
"party_id": string,
"registration": string,
"status": string,
"store_id": string | null,
"termination_date": string | null,
"time_bank": boolean,
"track_time": boolean,
"updated_at": string,
"weekly_hours": number,
"work_regime": string
            }
                          SetofOptions: {
        from: "*"
        to: "employees"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_run":
{ Args: { "p": Json }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"competence": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"id": string,
"journal_entry_id": string | null,
"kind": string,
"legal_entity_id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"reference_id": string | null,
"reference_type": string | null,
"source": string,
"status": string,
"totals": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "payroll_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_termination":
{ Args: { "p": Json }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"computed": NonNullable<Json>,
"created_at": string,
"created_by": string | null,
"employee_id": string,
"fgts_balance": number | null,
"id": string,
"kind": string,
"notes": string | null,
"notice_days": number | null,
"notice_kind": string,
"org_id": string,
"reason": string | null,
"run_id": string | null,
"status": string,
"termination_date": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "terminations"
        isOneToOne: true
        isSetofReturn: false
      } },
"delete_coverage_rule":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_shift_template":
{ Args: { "p_id": string }; Returns: undefined
                           },
"engage_freelancer":
{ Args: { "p": Json }; Returns: Json
                           },
"link_member":
{ Args: { "p_employee": string,"p_member": string }; Returns: undefined
                           },
"pay_vacation":
{ Args: { "p_vacation": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"competence": string,
"created_at": string,
"created_by": string | null,
"description": string | null,
"id": string,
"journal_entry_id": string | null,
"kind": string,
"legal_entity_id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"reference_id": string | null,
"reference_type": string | null,
"source": string,
"status": string,
"totals": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "payroll_runs"
        isOneToOne: true
        isSetofReturn: false
      } },
"publish_roster":
{ Args: { "p_from": string,"p_store": string,"p_to": string }; Returns: number
                           },
"recalc_termination":
{ Args: { "p"?: Json,"p_termination": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"computed": NonNullable<Json>,
"created_at": string,
"created_by": string | null,
"employee_id": string,
"fgts_balance": number | null,
"id": string,
"kind": string,
"notes": string | null,
"notice_days": number | null,
"notice_kind": string,
"org_id": string,
"reason": string | null,
"run_id": string | null,
"status": string,
"termination_date": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "terminations"
        isOneToOne: true
        isSetofReturn: false
      } },
"remove_line":
{ Args: { "p_line": string }; Returns: undefined
                           },
"reopen_timesheet":
{ Args: { "p_timesheet": string }; Returns: undefined
                           },
"roll_vacation_status":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"save_coverage_rule":
{ Args: { "p": Json }; Returns: number
                           },
"save_schedule_rules":
{ Args: { "p": Json }; Returns: Json
                           },
"save_shift_template":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"break_minutes": number,
"code": string,
"color": string,
"end_time": string,
"id": string,
"name": string,
"org_id": string,
"start_time": string,
"store_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "shift_templates"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_weekly_pattern":
{ Args: { "p_apply"?: boolean,"p_days": Json,"p_employee": string }; Returns: number
                           },
"schedule_rules":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"schedule_vacation":
{ Args: { "p": Json }; Returns: {
              "created_at": string,
"created_by": string | null,
"days": number,
"double_pay": boolean,
"employee_id": string,
"end_date": string,
"id": string,
"notes": string | null,
"org_id": string,
"pay_date": string | null,
"payslip_id": string | null,
"period_id": string,
"sell_days": number,
"start_date": string,
"status": string,
"thirteenth_advance": boolean,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "vacations"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_coverage_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: undefined
                           },
"set_roster_cell":
{ Args: { "p_date": string,"p_employee": string,"p_kind": string,"p_shift"?: string }; Returns: {
              "break_minutes": number,
"employee_id": string,
"end_time": string | null,
"id": string,
"kind": string,
"notes": string | null,
"org_id": string,
"shift_id": string | null,
"start_time": string | null,
"status": string,
"store_id": string,
"updated_at": string,
"updated_by": string | null,
"work_date": string
            }
                          SetofOptions: {
        from: "*"
        to: "roster"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_roster_hours":
{ Args: { "p_break"?: number,"p_date": string,"p_employee": string,"p_end": string,"p_notes"?: string,"p_start": string }; Returns: {
              "break_minutes": number,
"employee_id": string,
"end_time": string | null,
"id": string,
"kind": string,
"notes": string | null,
"org_id": string,
"shift_id": string | null,
"start_time": string | null,
"status": string,
"store_id": string,
"updated_at": string,
"updated_by": string | null,
"work_date": string
            }
                          SetofOptions: {
        from: "*"
        to: "roster"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_roster_notes":
{ Args: { "p_date": string,"p_employee": string,"p_notes": string }; Returns: undefined
                           },
"set_shift_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: {
              "active": boolean,
"break_minutes": number,
"code": string,
"color": string,
"end_time": string,
"id": string,
"name": string,
"org_id": string,
"start_time": string,
"store_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "shift_templates"
        isOneToOne: true
        isSetofReturn: false
      } },
"tax_data":
{ Args: { "p_kind": string,"p_on": string }; Returns: Json
                           },
"validate_roster":
{ Args: { "p_from": string,"p_store": string,"p_to": string }; Returns: {
              "code": string,"employee_id": string,"message": string,"severity": string,"work_date": string
            }[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"inv": {
          Tables: {
            "count_items": {
                  Row: {
                    "count_id": string,"counted": number,"expected": number | null,"id": string,"org_id": string,"variant_id": string
                  }
                  Insert: {
                    "count_id": string,"counted": number,"expected"?: number | null,"id"?: string,"org_id": string,"variant_id": string
                  }
                  Update: {
                    "count_id"?: string,"counted"?: number,"expected"?: number | null,"id"?: string,"org_id"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "count_items_count_id_fkey"
      columns: ["count_id"]
isOneToOne: false
      referencedRelation: "counts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "count_items_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"counts": {
                  Row: {
                    "created_at": string,"id": string,"kind": string,"location_id": string,"org_id": string,"posted_at": string | null,"status": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"kind": string,"location_id": string,"org_id": string,"posted_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"kind"?: string,"location_id"?: string,"org_id"?: string,"posted_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "counts_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    }
                  ]
                },"item_costs": {
                  Row: {
                    "avg_cost": number,"last_cost": number | null,"legal_entity_id": string,"org_id": string,"updated_at": string,"variant_id": string
                  }
                  Insert: {
                    "avg_cost"?: number,"last_cost"?: number | null,"legal_entity_id": string,"org_id": string,"updated_at"?: string,"variant_id": string
                  }
                  Update: {
                    "avg_cost"?: number,"last_cost"?: number | null,"legal_entity_id"?: string,"org_id"?: string,"updated_at"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_costs_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"locations": {
                  Row: {
                    "allow_negative": boolean,"created_at": string,"id": string,"is_sellable": boolean,"kind": Database["inv"]['Enums']["location_kind"],"legal_entity_id": string,"name": string,"org_id": string,"store_id": string | null
                  }
                  Insert: {
                    "allow_negative"?: boolean,"created_at"?: string,"id"?: string,"is_sellable"?: boolean,"kind": Database["inv"]['Enums']["location_kind"],"legal_entity_id": string,"name": string,"org_id": string,"store_id"?: string | null
                  }
                  Update: {
                    "allow_negative"?: boolean,"created_at"?: string,"id"?: string,"is_sellable"?: boolean,"kind"?: Database["inv"]['Enums']["location_kind"],"legal_entity_id"?: string,"name"?: string,"org_id"?: string,"store_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"lockers": {
                  Row: {
                    "code": string,"id": string,"org_id": string,"status": string,"store_id": string
                  }
                  Insert: {
                    "code": string,"id"?: string,"org_id": string,"status"?: string,"store_id": string
                  }
                  Update: {
                    "code"?: string,"id"?: string,"org_id"?: string,"status"?: string,"store_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"movements": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": number,"location_id": string,"movement_type": Database["inv"]['Enums']["movement_type"],"notes": string | null,"occurred_at": string,"org_id": string,"qty": number,"reversal_of_id": number | null,"source_id": string | null,"source_line_id": string | null,"source_type": string | null,"total_cost": number | null,"unit_cost": number | null,"variant_id": string
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: never,"location_id": string,"movement_type": Database["inv"]['Enums']["movement_type"],"notes"?: string | null,"occurred_at"?: string,"org_id": string,"qty": number,"reversal_of_id"?: number | null,"source_id"?: string | null,"source_line_id"?: string | null,"source_type"?: string | null,"total_cost"?: number | null,"unit_cost"?: number | null,"variant_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: never,"location_id"?: string,"movement_type"?: Database["inv"]['Enums']["movement_type"],"notes"?: string | null,"occurred_at"?: string,"org_id"?: string,"qty"?: number,"reversal_of_id"?: number | null,"source_id"?: string | null,"source_line_id"?: string | null,"source_type"?: string | null,"total_cost"?: number | null,"unit_cost"?: number | null,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "movements_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "movements_reversal_of_id_fkey"
      columns: ["reversal_of_id"]
isOneToOne: false
      referencedRelation: "movements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "movements_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"reservations": {
                  Row: {
                    "conversation_id": string | null,"created_at": string,"created_by_kind": string,"drop_id": string | null,"expires_at": string | null,"id": string,"location_id": string,"locker_id": string | null,"order_id": string | null,"org_id": string,"party_id": string | null,"qty": number,"reason": string,"status": string,"updated_at": string,"variant_id": string
                  }
                  Insert: {
                    "conversation_id"?: string | null,"created_at"?: string,"created_by_kind"?: string,"drop_id"?: string | null,"expires_at"?: string | null,"id"?: string,"location_id": string,"locker_id"?: string | null,"order_id"?: string | null,"org_id": string,"party_id"?: string | null,"qty": number,"reason": string,"status"?: string,"updated_at"?: string,"variant_id": string
                  }
                  Update: {
                    "conversation_id"?: string | null,"created_at"?: string,"created_by_kind"?: string,"drop_id"?: string | null,"expires_at"?: string | null,"id"?: string,"location_id"?: string,"locker_id"?: string | null,"order_id"?: string | null,"org_id"?: string,"party_id"?: string | null,"qty"?: number,"reason"?: string,"status"?: string,"updated_at"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reservations_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reservations_locker_id_fkey"
      columns: ["locker_id"]
isOneToOne: false
      referencedRelation: "lockers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reservations_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"stock_levels": {
                  Row: {
                    "available": number | null,"location_id": string,"on_hand": number,"org_id": string,"reserved": number,"updated_at": string,"variant_id": string
                  }
                  Insert: {
                    "available"?: never,"location_id": string,"on_hand"?: number,"org_id": string,"reserved"?: number,"updated_at"?: string,"variant_id": string
                  }
                  Update: {
                    "available"?: never,"location_id"?: string,"on_hand"?: number,"org_id"?: string,"reserved"?: number,"updated_at"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_levels_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_levels_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"transfer_items": {
                  Row: {
                    "id": string,"org_id": string,"qty": number,"qty_received": number | null,"transfer_id": string,"variant_id": string
                  }
                  Insert: {
                    "id"?: string,"org_id": string,"qty": number,"qty_received"?: number | null,"transfer_id": string,"variant_id": string
                  }
                  Update: {
                    "id"?: string,"org_id"?: string,"qty"?: number,"qty_received"?: number | null,"transfer_id"?: string,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transfer_items_transfer_id_fkey"
      columns: ["transfer_id"]
isOneToOne: false
      referencedRelation: "transfers"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transfer_items_variant_id_fkey"
      columns: ["variant_id"]
isOneToOne: false
      referencedRelation: "v_stock_matrix"
      referencedColumns: ["variant_id"]
    }
                  ]
                },"transfers": {
                  Row: {
                    "created_at": string,"fiscal_document_id": string | null,"from_location_id": string,"id": string,"number": string,"org_id": string,"status": string,"to_location_id": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"fiscal_document_id"?: string | null,"from_location_id": string,"id"?: string,"number": string,"org_id": string,"status"?: string,"to_location_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"fiscal_document_id"?: string | null,"from_location_id"?: string,"id"?: string,"number"?: string,"org_id"?: string,"status"?: string,"to_location_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transfers_from_location_id_fkey"
      columns: ["from_location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "transfers_to_location_id_fkey"
      columns: ["to_location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "v_stock_matrix": {
                  Row: {
                    "available": number | null,"color": string | null,"gender": Database["catalog"]['Enums']["gender"] | null,"location_id": string | null,"location_name": string | null,"on_hand": number | null,"org_id": string | null,"product_id": string | null,"product_name": string | null,"reference_code": string | null,"reserved": number | null,"size": string | null,"sku": string | null,"store_id": string | null,"variant_id": string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_levels_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "ensure_lockers":
{ Args: { "p_count": number,"p_store": string }; Returns: number
                           },
"expire_reservations":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"post_count":
{ Args: { "p_count": string }; Returns: number
                           },
"release_reservation":
{ Args: { "p_reservation": string }; Returns: undefined
                           },
"reserve":
{ Args: { "p": Json }; Returns: {
              "conversation_id": string | null,
"created_at": string,
"created_by_kind": string,
"drop_id": string | null,
"expires_at": string | null,
"id": string,
"location_id": string,
"locker_id": string | null,
"order_id": string | null,
"org_id": string,
"party_id": string | null,
"qty": number,
"reason": string,
"status": string,
"updated_at": string,
"variant_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "reservations"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            "location_kind": "SALES_FLOOR"|"BACKROOM"|"VIP_LOCKERS"|"IN_TRANSIT"|"CONSIGNMENT_AT_PARTNER"|"POPUP"|"DAMAGED"|"MARKETING","movement_type": "INITIAL_BALANCE"|"PURCHASE_RECEIPT"|"SALE"|"SALE_RETURN"|"EXCHANGE_IN"|"EXCHANGE_OUT"|"TRANSFER_OUT"|"TRANSFER_IN"|"COUNT_ADJUST"|"LOSS"|"DAMAGE"|"SPONSORSHIP_IN_KIND"|"MARKETING_GIFT"|"CONSIGNMENT_OUT"|"CONSIGNMENT_RETURN"|"SUPPLIER_RETURN"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"mkt": {
          Tables: {
            "ad_insights_daily": {
                  Row: {
                    "ad_account": string,"ad_id": string,"ad_name": string | null,"adset_name": string | null,"campaign_id": string | null,"campaign_name": string | null,"clicks": number,"conversations": number,"day": string,"id": string,"impressions": number,"leads": number,"org_id": string,"purchase_value": number,"purchases": number,"reach": number,"spend": number,"updated_at": string
                  }
                  Insert: {
                    "ad_account": string,"ad_id": string,"ad_name"?: string | null,"adset_name"?: string | null,"campaign_id"?: string | null,"campaign_name"?: string | null,"clicks"?: number,"conversations"?: number,"day": string,"id"?: string,"impressions"?: number,"leads"?: number,"org_id": string,"purchase_value"?: number,"purchases"?: number,"reach"?: number,"spend"?: number,"updated_at"?: string
                  }
                  Update: {
                    "ad_account"?: string,"ad_id"?: string,"ad_name"?: string | null,"adset_name"?: string | null,"campaign_id"?: string | null,"campaign_name"?: string | null,"clicks"?: number,"conversations"?: number,"day"?: string,"id"?: string,"impressions"?: number,"leads"?: number,"org_id"?: string,"purchase_value"?: number,"purchases"?: number,"reach"?: number,"spend"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ad_sync_state": {
                  Row: {
                    "ad_account": string,"last_day": string | null,"last_error": string | null,"last_rows": number,"last_run_at": string | null,"org_id": string
                  }
                  Insert: {
                    "ad_account": string,"last_day"?: string | null,"last_error"?: string | null,"last_rows"?: number,"last_run_at"?: string | null,"org_id": string
                  }
                  Update: {
                    "ad_account"?: string,"last_day"?: string | null,"last_error"?: string | null,"last_rows"?: number,"last_run_at"?: string | null,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"attribution_touches": {
                  Row: {
                    "ad_id": string | null,"conversation_id": string | null,"detail": NonNullable<Json>,"id": number,"is_first": boolean,"kind": string,"message_id": string | null,"org_id": string,"party_id": string,"touched_at": string,"tracking_link_id": string | null
                  }
                  Insert: {
                    "ad_id"?: string | null,"conversation_id"?: string | null,"detail"?: NonNullable<Json>,"id"?: never,"is_first"?: boolean,"kind": string,"message_id"?: string | null,"org_id": string,"party_id": string,"touched_at"?: string,"tracking_link_id"?: string | null
                  }
                  Update: {
                    "ad_id"?: string | null,"conversation_id"?: string | null,"detail"?: NonNullable<Json>,"id"?: never,"is_first"?: boolean,"kind"?: string,"message_id"?: string | null,"org_id"?: string,"party_id"?: string,"touched_at"?: string,"tracking_link_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "attribution_touches_tracking_link_id_fkey"
      columns: ["tracking_link_id"]
isOneToOne: false
      referencedRelation: "tracking_links"
      referencedColumns: ["id"]
    }
                  ]
                },"campaign_recipients": {
                  Row: {
                    "campaign_id": string,"created_at": string,"id": string,"message_id": string | null,"org_id": string,"party_id": string,"sent_at": string | null,"seq": number,"skip_reason": string | null,"status": string
                  }
                  Insert: {
                    "campaign_id": string,"created_at"?: string,"id"?: string,"message_id"?: string | null,"org_id": string,"party_id": string,"sent_at"?: string | null,"seq"?: never,"skip_reason"?: string | null,"status"?: string
                  }
                  Update: {
                    "campaign_id"?: string,"created_at"?: string,"id"?: string,"message_id"?: string | null,"org_id"?: string,"party_id"?: string,"sent_at"?: string | null,"seq"?: never,"skip_reason"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "campaign_recipients_campaign_id_fkey"
      columns: ["campaign_id"]
isOneToOne: false
      referencedRelation: "campaigns"
      referencedColumns: ["id"]
    }
                  ]
                },"campaigns": {
                  Row: {
                    "audience": NonNullable<Json>,"channel_account_id": string,"created_at": string,"created_by": string | null,"daily_limit": number,"finished_at": string | null,"frequency_cap_days": number,"id": string,"name": string,"org_id": string,"scheduled_at": string | null,"started_at": string | null,"status": string,"template_id": string,"updated_at": string,"variables": NonNullable<Json>
                  }
                  Insert: {
                    "audience"?: NonNullable<Json>,"channel_account_id": string,"created_at"?: string,"created_by"?: string | null,"daily_limit"?: number,"finished_at"?: string | null,"frequency_cap_days"?: number,"id"?: string,"name": string,"org_id": string,"scheduled_at"?: string | null,"started_at"?: string | null,"status"?: string,"template_id": string,"updated_at"?: string,"variables"?: NonNullable<Json>
                  }
                  Update: {
                    "audience"?: NonNullable<Json>,"channel_account_id"?: string,"created_at"?: string,"created_by"?: string | null,"daily_limit"?: number,"finished_at"?: string | null,"frequency_cap_days"?: number,"id"?: string,"name"?: string,"org_id"?: string,"scheduled_at"?: string | null,"started_at"?: string | null,"status"?: string,"template_id"?: string,"updated_at"?: string,"variables"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"capi_events": {
                  Row: {
                    "attempted_at": string,"event_name": string,"order_id": string,"org_id": string,"reason": string | null,"response": Json | null,"status": string
                  }
                  Insert: {
                    "attempted_at"?: string,"event_name"?: string,"order_id": string,"org_id": string,"reason"?: string | null,"response"?: Json | null,"status": string
                  }
                  Update: {
                    "attempted_at"?: string,"event_name"?: string,"order_id"?: string,"org_id"?: string,"reason"?: string | null,"response"?: Json | null,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                },"event_budget_lines": {
                  Row: {
                    "category": string,"created_at": string,"event_id": string,"id": string,"memo": string | null,"org_id": string,"planned": number
                  }
                  Insert: {
                    "category": string,"created_at"?: string,"event_id": string,"id"?: string,"memo"?: string | null,"org_id": string,"planned": number
                  }
                  Update: {
                    "category"?: string,"created_at"?: string,"event_id"?: string,"id"?: string,"memo"?: string | null,"org_id"?: string,"planned"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_budget_lines_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                },"event_guests": {
                  Row: {
                    "checked_in_at": string | null,"checkin_token": string,"created_at": string,"deal_id": string | null,"event_id": string,"id": string,"invited_by": string | null,"notes": string | null,"org_id": string,"party_id": string,"plus_ones": number,"rsvp_status": string,"source": string,"updated_at": string
                  }
                  Insert: {
                    "checked_in_at"?: string | null,"checkin_token"?: string,"created_at"?: string,"deal_id"?: string | null,"event_id": string,"id"?: string,"invited_by"?: string | null,"notes"?: string | null,"org_id": string,"party_id": string,"plus_ones"?: number,"rsvp_status"?: string,"source"?: string,"updated_at"?: string
                  }
                  Update: {
                    "checked_in_at"?: string | null,"checkin_token"?: string,"created_at"?: string,"deal_id"?: string | null,"event_id"?: string,"id"?: string,"invited_by"?: string | null,"notes"?: string | null,"org_id"?: string,"party_id"?: string,"plus_ones"?: number,"rsvp_status"?: string,"source"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "event_guests_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                },"events": {
                  Row: {
                    "capacity": number | null,"collection_id": string | null,"cost_center_id": string | null,"created_at": string,"created_by": string | null,"ends_at": string | null,"id": string,"kind": string,"name": string,"notes": string | null,"org_id": string,"presale_starts_at": string | null,"public_starts_at": string | null,"starts_at": string,"status": string,"store_id": string | null,"target_revenue": number | null,"updated_at": string,"venue": string | null
                  }
                  Insert: {
                    "capacity"?: number | null,"collection_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string | null,"id"?: string,"kind": string,"name": string,"notes"?: string | null,"org_id": string,"presale_starts_at"?: string | null,"public_starts_at"?: string | null,"starts_at": string,"status"?: string,"store_id"?: string | null,"target_revenue"?: number | null,"updated_at"?: string,"venue"?: string | null
                  }
                  Update: {
                    "capacity"?: number | null,"collection_id"?: string | null,"cost_center_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"ends_at"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"notes"?: string | null,"org_id"?: string,"presale_starts_at"?: string | null,"public_starts_at"?: string | null,"starts_at"?: string,"status"?: string,"store_id"?: string | null,"target_revenue"?: number | null,"updated_at"?: string,"venue"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"journey_enrollments": {
                  Row: {
                    "converted_at": string | null,"converted_order_id": string | null,"enrolled_at": string,"exit_reason": string | null,"finished_at": string | null,"grp": string,"id": string,"journey_id": string,"next_run_at": string | null,"next_step": number,"org_id": string,"party_id": string,"source_key": string,"status": string
                  }
                  Insert: {
                    "converted_at"?: string | null,"converted_order_id"?: string | null,"enrolled_at"?: string,"exit_reason"?: string | null,"finished_at"?: string | null,"grp": string,"id"?: string,"journey_id": string,"next_run_at"?: string | null,"next_step"?: number,"org_id": string,"party_id": string,"source_key": string,"status"?: string
                  }
                  Update: {
                    "converted_at"?: string | null,"converted_order_id"?: string | null,"enrolled_at"?: string,"exit_reason"?: string | null,"finished_at"?: string | null,"grp"?: string,"id"?: string,"journey_id"?: string,"next_run_at"?: string | null,"next_step"?: number,"org_id"?: string,"party_id"?: string,"source_key"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "journey_enrollments_journey_id_fkey"
      columns: ["journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["id"]
    }
                  ]
                },"journey_events": {
                  Row: {
                    "created_at": string,"enrollment_id": string,"id": number,"message_id": string | null,"org_id": string,"reason": string | null,"result": string,"step_position": number,"task_id": string | null
                  }
                  Insert: {
                    "created_at"?: string,"enrollment_id": string,"id"?: never,"message_id"?: string | null,"org_id": string,"reason"?: string | null,"result": string,"step_position": number,"task_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"enrollment_id"?: string,"id"?: never,"message_id"?: string | null,"org_id"?: string,"reason"?: string | null,"result"?: string,"step_position"?: number,"task_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "journey_events_enrollment_id_fkey"
      columns: ["enrollment_id"]
isOneToOne: false
      referencedRelation: "journey_enrollments"
      referencedColumns: ["id"]
    }
                  ]
                },"journey_steps": {
                  Row: {
                    "action": string,"due_hours": number,"id": string,"journey_id": string,"message": string | null,"org_id": string,"position": number,"template_id": string | null,"template_vars": NonNullable<Json>,"title": string,"wait_days": number
                  }
                  Insert: {
                    "action": string,"due_hours"?: number,"id"?: string,"journey_id": string,"message"?: string | null,"org_id": string,"position": number,"template_id"?: string | null,"template_vars"?: NonNullable<Json>,"title": string,"wait_days"?: number
                  }
                  Update: {
                    "action"?: string,"due_hours"?: number,"id"?: string,"journey_id"?: string,"message"?: string | null,"org_id"?: string,"position"?: number,"template_id"?: string | null,"template_vars"?: NonNullable<Json>,"title"?: string,"wait_days"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "journey_steps_journey_id_fkey"
      columns: ["journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["id"]
    }
                  ]
                },"journeys": {
                  Row: {
                    "active": boolean,"created_at": string,"description": string | null,"exit_on_purchase": boolean,"holdout_pct": number,"id": string,"key": string,"name": string,"org_id": string,"trigger": string,"trigger_config": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"description"?: string | null,"exit_on_purchase"?: boolean,"holdout_pct"?: number,"id"?: string,"key": string,"name": string,"org_id": string,"trigger": string,"trigger_config"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"description"?: string | null,"exit_on_purchase"?: boolean,"holdout_pct"?: number,"id"?: string,"key"?: string,"name"?: string,"org_id"?: string,"trigger"?: string,"trigger_config"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"tracking_links": {
                  Row: {
                    "active": boolean,"affiliate_party_id": string | null,"channel_account_id": string,"code": string,"created_at": string,"created_by": string | null,"event_id": string | null,"id": string,"kind": string,"name": string,"org_id": string,"prefill_text": string | null,"referrer_party_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"affiliate_party_id"?: string | null,"channel_account_id": string,"code": string,"created_at"?: string,"created_by"?: string | null,"event_id"?: string | null,"id"?: string,"kind"?: string,"name": string,"org_id": string,"prefill_text"?: string | null,"referrer_party_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"affiliate_party_id"?: string | null,"channel_account_id"?: string,"code"?: string,"created_at"?: string,"created_by"?: string | null,"event_id"?: string | null,"id"?: string,"kind"?: string,"name"?: string,"org_id"?: string,"prefill_text"?: string | null,"referrer_party_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tracking_links_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "ad_insights_upsert":
{ Args: { "p_account": string,"p_org": string,"p_rows": Json }; Returns: number
                           },
"ad_sync_set":
{ Args: { "p_account": string,"p_error"?: string,"p_last_day": string,"p_org": string,"p_rows": number }; Returns: undefined
                           },
"ads_overview":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"campaign_preview":
{ Args: { "p_id": string }; Returns: Json
                           },
"campaign_results":
{ Args: { "p_id": string }; Returns: Json
                           },
"campaign_send_batch":
{ Args: { "p_campaign": string,"p_limit"?: number }; Returns: Json
                           },
"cancel_campaign":
{ Args: { "p_id": string }; Returns: {
              "audience": NonNullable<Json>,
"channel_account_id": string,
"created_at": string,
"created_by": string | null,
"daily_limit": number,
"finished_at": string | null,
"frequency_cap_days": number,
"id": string,
"name": string,
"org_id": string,
"scheduled_at": string | null,
"started_at": string | null,
"status": string,
"template_id": string,
"updated_at": string,
"variables": NonNullable<Json>
            }
                          SetofOptions: {
        from: "*"
        to: "campaigns"
        isOneToOne: true
        isSetofReturn: false
      } },
"capi_payload":
{ Args: { "p_order": string }; Returns: Json
                           },
"capi_record":
{ Args: { "p": Json }; Returns: undefined
                           },
"checkin_by_token":
{ Args: { "p_plus_ones"?: number,"p_token": string }; Returns: Json
                           },
"checkin_walkin":
{ Args: { "p": Json }; Returns: Json
                           },
"delete_budget_line":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_campaign":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_journey_step":
{ Args: { "p_id": string }; Returns: undefined
                           },
"event_guest_sales":
{ Args: { "p_event": string }; Returns: {
              "orders": number,"party_id": string,"revenue": number
            }[]
                           },
"event_results":
{ Args: { "p_event": string }; Returns: Json
                           },
"guest_by_token":
{ Args: { "p_token": string }; Returns: Json
                           },
"invite_audience":
{ Args: { "p_def": Json,"p_event": string }; Returns: number
                           },
"invite_guests":
{ Args: { "p_event": string,"p_parties": (string)[],"p_source"?: string }; Returns: number
                           },
"invite_vips":
{ Args: { "p_event": string }; Returns: number
                           },
"journey_report":
{ Args: { "p_days"?: number,"p_journey": string }; Returns: Json
                           },
"launch_campaign":
{ Args: { "p_id": string }; Returns: {
              "audience": NonNullable<Json>,
"channel_account_id": string,
"created_at": string,
"created_by": string | null,
"daily_limit": number,
"finished_at": string | null,
"frequency_cap_days": number,
"id": string,
"name": string,
"org_id": string,
"scheduled_at": string | null,
"started_at": string | null,
"status": string,
"template_id": string,
"updated_at": string,
"variables": NonNullable<Json>
            }
                          SetofOptions: {
        from: "*"
        to: "campaigns"
        isOneToOne: true
        isSetofReturn: false
      } },
"remove_guest":
{ Args: { "p_guest": string }; Returns: undefined
                           },
"report_journeys":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "enrolled": number,"holdout": number,"holdout_rate": number,"journey": string,"lift_pp": number,"revenue": number,"treatment": number,"treatment_rate": number
            }[]
                           },
"request_ads_sync":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"save_budget_line":
{ Args: { "p": Json }; Returns: {
              "category": string,
"created_at": string,
"event_id": string,
"id": string,
"memo": string | null,
"org_id": string,
"planned": number
            }
                          SetofOptions: {
        from: "*"
        to: "event_budget_lines"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_campaign":
{ Args: { "p": Json }; Returns: {
              "audience": NonNullable<Json>,
"channel_account_id": string,
"created_at": string,
"created_by": string | null,
"daily_limit": number,
"finished_at": string | null,
"frequency_cap_days": number,
"id": string,
"name": string,
"org_id": string,
"scheduled_at": string | null,
"started_at": string | null,
"status": string,
"template_id": string,
"updated_at": string,
"variables": NonNullable<Json>
            }
                          SetofOptions: {
        from: "*"
        to: "campaigns"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_contact_policy":
{ Args: { "p": Json }; Returns: Json
                           },
"save_event":
{ Args: { "p": Json }; Returns: {
              "capacity": number | null,
"collection_id": string | null,
"cost_center_id": string | null,
"created_at": string,
"created_by": string | null,
"ends_at": string | null,
"id": string,
"kind": string,
"name": string,
"notes": string | null,
"org_id": string,
"presale_starts_at": string | null,
"public_starts_at": string | null,
"starts_at": string,
"status": string,
"store_id": string | null,
"target_revenue": number | null,
"updated_at": string,
"venue": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_journey":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"created_at": string,
"description": string | null,
"exit_on_purchase": boolean,
"holdout_pct": number,
"id": string,
"key": string,
"name": string,
"org_id": string,
"trigger": string,
"trigger_config": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "journeys"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_journey_step":
{ Args: { "p": Json }; Returns: {
              "action": string,
"due_hours": number,
"id": string,
"journey_id": string,
"message": string | null,
"org_id": string,
"position": number,
"template_id": string | null,
"template_vars": NonNullable<Json>,
"title": string,
"wait_days": number
            }
                          SetofOptions: {
        from: "*"
        to: "journey_steps"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_tracking_link":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"affiliate_party_id": string | null,
"channel_account_id": string,
"code": string,
"created_at": string,
"created_by": string | null,
"event_id": string | null,
"id": string,
"kind": string,
"name": string,
"org_id": string,
"prefill_text": string | null,
"referrer_party_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "tracking_links"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_event_presale":
{ Args: { "p_event": string,"p_presale": string,"p_public": string }; Returns: {
              "capacity": number | null,
"collection_id": string | null,
"cost_center_id": string | null,
"created_at": string,
"created_by": string | null,
"ends_at": string | null,
"id": string,
"kind": string,
"name": string,
"notes": string | null,
"org_id": string,
"presale_starts_at": string | null,
"public_starts_at": string | null,
"starts_at": string,
"status": string,
"store_id": string | null,
"target_revenue": number | null,
"updated_at": string,
"venue": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_event_status":
{ Args: { "p_id": string,"p_status": string }; Returns: {
              "capacity": number | null,
"collection_id": string | null,
"cost_center_id": string | null,
"created_at": string,
"created_by": string | null,
"ends_at": string | null,
"id": string,
"kind": string,
"name": string,
"notes": string | null,
"org_id": string,
"presale_starts_at": string | null,
"public_starts_at": string | null,
"starts_at": string,
"status": string,
"store_id": string | null,
"target_revenue": number | null,
"updated_at": string,
"venue": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "events"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_journey_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: {
              "active": boolean,
"created_at": string,
"description": string | null,
"exit_on_purchase": boolean,
"holdout_pct": number,
"id": string,
"key": string,
"name": string,
"org_id": string,
"trigger": string,
"trigger_config": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "journeys"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_rsvp":
{ Args: { "p_guest": string,"p_plus_ones"?: number,"p_status": string }; Returns: {
              "checked_in_at": string | null,
"checkin_token": string,
"created_at": string,
"deal_id": string | null,
"event_id": string,
"id": string,
"invited_by": string | null,
"notes": string | null,
"org_id": string,
"party_id": string,
"plus_ones": number,
"rsvp_status": string,
"source": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "event_guests"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_tracking_link_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: undefined
                           },
"tracking_link_stats":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "active": boolean,"buyers": number,"code": string,"kind": string,"link_id": string,"name": string,"new_leads": number,"orders": number,"revenue": number,"touches": number
            }[]
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"omni": {
          Tables: {
            "automation_runs": {
                  Row: {
                    "automation_id": string,"conversation_id": string | null,"created_at": string,"detail": NonNullable<Json>,"id": string,"message_id": string | null,"org_id": string,"party_id": string | null,"reason": string | null,"status": string
                  }
                  Insert: {
                    "automation_id": string,"conversation_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"message_id"?: string | null,"org_id": string,"party_id"?: string | null,"reason"?: string | null,"status": string
                  }
                  Update: {
                    "automation_id"?: string,"conversation_id"?: string | null,"created_at"?: string,"detail"?: NonNullable<Json>,"id"?: string,"message_id"?: string | null,"org_id"?: string,"party_id"?: string | null,"reason"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "automation_runs_automation_id_fkey"
      columns: ["automation_id"]
isOneToOne: false
      referencedRelation: "automations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "automation_runs_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "automation_runs_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"automations": {
                  Row: {
                    "actions": NonNullable<Json>,"active": boolean,"channel_account_id": string | null,"conditions": NonNullable<Json>,"cooldown_days": number,"created_at": string,"created_by": string | null,"id": string,"last_run_at": string | null,"name": string,"org_id": string,"priority": number,"trigger": string,"updated_at": string
                  }
                  Insert: {
                    "actions"?: NonNullable<Json>,"active"?: boolean,"channel_account_id"?: string | null,"conditions"?: NonNullable<Json>,"cooldown_days"?: number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"last_run_at"?: string | null,"name": string,"org_id": string,"priority"?: number,"trigger": string,"updated_at"?: string
                  }
                  Update: {
                    "actions"?: NonNullable<Json>,"active"?: boolean,"channel_account_id"?: string | null,"conditions"?: NonNullable<Json>,"cooldown_days"?: number,"created_at"?: string,"created_by"?: string | null,"id"?: string,"last_run_at"?: string | null,"name"?: string,"org_id"?: string,"priority"?: number,"trigger"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "automations_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"channel_accounts": {
                  Row: {
                    "business_hours": NonNullable<Json>,"channel": Database["omni"]['Enums']["channel"],"connection_id": string | null,"created_at": string,"default_ai_mode": Database["omni"]['Enums']["conv_mode"],"default_persona_id": string | null,"display_name": string,"id": string,"org_id": string,"provider_account_id": string,"public_address": string | null,"status": string,"store_id": string | null,"updated_at": string
                  }
                  Insert: {
                    "business_hours"?: NonNullable<Json>,"channel": Database["omni"]['Enums']["channel"],"connection_id"?: string | null,"created_at"?: string,"default_ai_mode"?: Database["omni"]['Enums']["conv_mode"],"default_persona_id"?: string | null,"display_name": string,"id"?: string,"org_id": string,"provider_account_id": string,"public_address"?: string | null,"status"?: string,"store_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "business_hours"?: NonNullable<Json>,"channel"?: Database["omni"]['Enums']["channel"],"connection_id"?: string | null,"created_at"?: string,"default_ai_mode"?: Database["omni"]['Enums']["conv_mode"],"default_persona_id"?: string | null,"display_name"?: string,"id"?: string,"org_id"?: string,"provider_account_id"?: string,"public_address"?: string | null,"status"?: string,"store_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"channel_identities": {
                  Row: {
                    "channel_account_id": string,"created_at": string,"external_id": string,"id": string,"org_id": string,"party_id": string,"profile": NonNullable<Json>
                  }
                  Insert: {
                    "channel_account_id": string,"created_at"?: string,"external_id": string,"id"?: string,"org_id": string,"party_id": string,"profile"?: NonNullable<Json>
                  }
                  Update: {
                    "channel_account_id"?: string,"created_at"?: string,"external_id"?: string,"id"?: string,"org_id"?: string,"party_id"?: string,"profile"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "channel_identities_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"conversations": {
                  Row: {
                    "ai_instruction": string | null,"ai_paused_until": string | null,"assignee_member_id": string | null,"channel_account_id": string,"channel_identity_id": string,"closed_at": string | null,"closed_by": string | null,"created_at": string,"deal_id": string | null,"human_agent_window_expires_at": string | null,"id": string,"intent": string | null,"last_inbound_at": string | null,"last_message_at": string | null,"mode": Database["omni"]['Enums']["conv_mode"],"org_id": string,"outcome": string | null,"outcome_note": string | null,"outcome_source": string | null,"party_id": string,"pending_ai_at": string | null,"persona_id": string | null,"priority": number,"sentiment": string | null,"service_window_expires_at": string | null,"sla_alerted_at": string | null,"sla_due_at": string | null,"status": string,"summary": string | null,"tags": (string)[],"topics": (string)[],"unread_count": number,"updated_at": string,"version": number,"window_alerted_at": string | null
                  }
                  Insert: {
                    "ai_instruction"?: string | null,"ai_paused_until"?: string | null,"assignee_member_id"?: string | null,"channel_account_id": string,"channel_identity_id": string,"closed_at"?: string | null,"closed_by"?: string | null,"created_at"?: string,"deal_id"?: string | null,"human_agent_window_expires_at"?: string | null,"id"?: string,"intent"?: string | null,"last_inbound_at"?: string | null,"last_message_at"?: string | null,"mode"?: Database["omni"]['Enums']["conv_mode"],"org_id": string,"outcome"?: string | null,"outcome_note"?: string | null,"outcome_source"?: string | null,"party_id": string,"pending_ai_at"?: string | null,"persona_id"?: string | null,"priority"?: number,"sentiment"?: string | null,"service_window_expires_at"?: string | null,"sla_alerted_at"?: string | null,"sla_due_at"?: string | null,"status"?: string,"summary"?: string | null,"tags"?: (string)[],"topics"?: (string)[],"unread_count"?: number,"updated_at"?: string,"version"?: number,"window_alerted_at"?: string | null
                  }
                  Update: {
                    "ai_instruction"?: string | null,"ai_paused_until"?: string | null,"assignee_member_id"?: string | null,"channel_account_id"?: string,"channel_identity_id"?: string,"closed_at"?: string | null,"closed_by"?: string | null,"created_at"?: string,"deal_id"?: string | null,"human_agent_window_expires_at"?: string | null,"id"?: string,"intent"?: string | null,"last_inbound_at"?: string | null,"last_message_at"?: string | null,"mode"?: Database["omni"]['Enums']["conv_mode"],"org_id"?: string,"outcome"?: string | null,"outcome_note"?: string | null,"outcome_source"?: string | null,"party_id"?: string,"pending_ai_at"?: string | null,"persona_id"?: string | null,"priority"?: number,"sentiment"?: string | null,"service_window_expires_at"?: string | null,"sla_alerted_at"?: string | null,"sla_due_at"?: string | null,"status"?: string,"summary"?: string | null,"tags"?: (string)[],"topics"?: (string)[],"unread_count"?: number,"updated_at"?: string,"version"?: number,"window_alerted_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversations_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversations_channel_identity_id_fkey"
      columns: ["channel_identity_id"]
isOneToOne: false
      referencedRelation: "channel_identities"
      referencedColumns: ["id"]
    }
                  ]
                },"csat_responses": {
                  Row: {
                    "answered_at": string | null,"asked_at": string,"asked_message_id": string | null,"assignee_member_id": string | null,"channel_account_id": string,"conversation_id": string,"id": string,"org_id": string,"party_id": string,"score": number | null
                  }
                  Insert: {
                    "answered_at"?: string | null,"asked_at"?: string,"asked_message_id"?: string | null,"assignee_member_id"?: string | null,"channel_account_id": string,"conversation_id": string,"id"?: string,"org_id": string,"party_id": string,"score"?: number | null
                  }
                  Update: {
                    "answered_at"?: string | null,"asked_at"?: string,"asked_message_id"?: string | null,"assignee_member_id"?: string | null,"channel_account_id"?: string,"conversation_id"?: string,"id"?: string,"org_id"?: string,"party_id"?: string,"score"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "csat_responses_asked_message_id_fkey"
      columns: ["asked_message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "csat_responses_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "csat_responses_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: true
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"internal_notes": {
                  Row: {
                    "body": string,"conversation_id": string,"created_at": string,"id": string,"member_id": string,"mentions": (string)[],"org_id": string
                  }
                  Insert: {
                    "body": string,"conversation_id": string,"created_at"?: string,"id"?: string,"member_id": string,"mentions"?: (string)[],"org_id": string
                  }
                  Update: {
                    "body"?: string,"conversation_id"?: string,"created_at"?: string,"id"?: string,"member_id"?: string,"mentions"?: (string)[],"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "internal_notes_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"message_drafts": {
                  Row: {
                    "ai_run_id": string | null,"confidence": number | null,"conversation_id": string,"created_at": string,"decided_by": string | null,"discard_reason": string | null,"final_message_id": string | null,"flags": (string)[],"id": string,"intent": string | null,"needs_human": boolean,"org_id": string,"stage": string | null,"status": string,"variants": NonNullable<Json>
                  }
                  Insert: {
                    "ai_run_id"?: string | null,"confidence"?: number | null,"conversation_id": string,"created_at"?: string,"decided_by"?: string | null,"discard_reason"?: string | null,"final_message_id"?: string | null,"flags"?: (string)[],"id"?: string,"intent"?: string | null,"needs_human"?: boolean,"org_id": string,"stage"?: string | null,"status"?: string,"variants": NonNullable<Json>
                  }
                  Update: {
                    "ai_run_id"?: string | null,"confidence"?: number | null,"conversation_id"?: string,"created_at"?: string,"decided_by"?: string | null,"discard_reason"?: string | null,"final_message_id"?: string | null,"flags"?: (string)[],"id"?: string,"intent"?: string | null,"needs_human"?: boolean,"org_id"?: string,"stage"?: string | null,"status"?: string,"variants"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "message_drafts_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "message_drafts_final_message_id_fkey"
      columns: ["final_message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"messages": {
                  Row: {
                    "ai_run_id": string | null,"author_member_id": string | null,"author_type": string,"body": string | null,"channel_account_id": string,"client_dedupe_key": string | null,"conversation_id": string,"created_at": string,"direction": string,"error": string | null,"id": string,"media_path": string | null,"org_id": string,"payload": NonNullable<Json>,"provider_message_id": string | null,"reply_to_id": string | null,"sent_at": string | null,"seq": number,"status": string,"template_name": string | null,"transcript": string | null,"type": string
                  }
                  Insert: {
                    "ai_run_id"?: string | null,"author_member_id"?: string | null,"author_type": string,"body"?: string | null,"channel_account_id": string,"client_dedupe_key"?: string | null,"conversation_id": string,"created_at"?: string,"direction": string,"error"?: string | null,"id"?: string,"media_path"?: string | null,"org_id": string,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"reply_to_id"?: string | null,"sent_at"?: string | null,"seq"?: never,"status"?: string,"template_name"?: string | null,"transcript"?: string | null,"type"?: string
                  }
                  Update: {
                    "ai_run_id"?: string | null,"author_member_id"?: string | null,"author_type"?: string,"body"?: string | null,"channel_account_id"?: string,"client_dedupe_key"?: string | null,"conversation_id"?: string,"created_at"?: string,"direction"?: string,"error"?: string | null,"id"?: string,"media_path"?: string | null,"org_id"?: string,"payload"?: NonNullable<Json>,"provider_message_id"?: string | null,"reply_to_id"?: string | null,"sent_at"?: string | null,"seq"?: never,"status"?: string,"template_name"?: string | null,"transcript"?: string | null,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_reply_to_id_fkey"
      columns: ["reply_to_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"mode_events": {
                  Row: {
                    "actor_member_id": string | null,"actor_type": string,"conversation_id": string,"created_at": string,"from_mode": Database["omni"]['Enums']["conv_mode"] | null,"id": number,"org_id": string,"reason": string | null,"to_mode": Database["omni"]['Enums']["conv_mode"],"trigger": string
                  }
                  Insert: {
                    "actor_member_id"?: string | null,"actor_type": string,"conversation_id": string,"created_at"?: string,"from_mode"?: Database["omni"]['Enums']["conv_mode"] | null,"id"?: never,"org_id": string,"reason"?: string | null,"to_mode": Database["omni"]['Enums']["conv_mode"],"trigger": string
                  }
                  Update: {
                    "actor_member_id"?: string | null,"actor_type"?: string,"conversation_id"?: string,"created_at"?: string,"from_mode"?: Database["omni"]['Enums']["conv_mode"] | null,"id"?: never,"org_id"?: string,"reason"?: string | null,"to_mode"?: Database["omni"]['Enums']["conv_mode"],"trigger"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "mode_events_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"notice_rules": {
                  Row: {
                    "active": boolean,"channel_account_id": string | null,"event": string,"free_text": string,"id": string,"org_id": string,"task_fallback": boolean,"template_id": string | null,"template_vars": NonNullable<Json>,"updated_at": string
                  }
                  Insert: {
                    "active"?: boolean,"channel_account_id"?: string | null,"event": string,"free_text": string,"id"?: string,"org_id": string,"task_fallback"?: boolean,"template_id"?: string | null,"template_vars"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Update: {
                    "active"?: boolean,"channel_account_id"?: string | null,"event"?: string,"free_text"?: string,"id"?: string,"org_id"?: string,"task_fallback"?: boolean,"template_id"?: string | null,"template_vars"?: NonNullable<Json>,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notice_rules_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notice_rules_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "templates"
      referencedColumns: ["id"]
    }
                  ]
                },"notices_log": {
                  Row: {
                    "conversation_id": string | null,"created_at": string,"event": string,"id": number,"message_id": string | null,"org_id": string,"party_id": string,"reason": string | null,"source_id": string,"status": string,"task_id": string | null
                  }
                  Insert: {
                    "conversation_id"?: string | null,"created_at"?: string,"event": string,"id"?: never,"message_id"?: string | null,"org_id": string,"party_id": string,"reason"?: string | null,"source_id": string,"status": string,"task_id"?: string | null
                  }
                  Update: {
                    "conversation_id"?: string | null,"created_at"?: string,"event"?: string,"id"?: never,"message_id"?: string | null,"org_id"?: string,"party_id"?: string,"reason"?: string | null,"source_id"?: string,"status"?: string,"task_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "notices_log_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notices_log_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    }
                  ]
                },"nps_responses": {
                  Row: {
                    "answered_at": string | null,"asked_at": string,"channel_account_id": string | null,"comment": string | null,"id": string,"order_id": string | null,"org_id": string,"party_id": string,"score": number | null,"via": string
                  }
                  Insert: {
                    "answered_at"?: string | null,"asked_at"?: string,"channel_account_id"?: string | null,"comment"?: string | null,"id"?: string,"order_id"?: string | null,"org_id": string,"party_id": string,"score"?: number | null,"via"?: string
                  }
                  Update: {
                    "answered_at"?: string | null,"asked_at"?: string,"channel_account_id"?: string | null,"comment"?: string | null,"id"?: string,"order_id"?: string | null,"org_id"?: string,"party_id"?: string,"score"?: number | null,"via"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "nps_responses_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"quick_replies": {
                  Row: {
                    "body": string,"id": string,"org_id": string,"shortcut": string
                  }
                  Insert: {
                    "body": string,"id"?: string,"org_id": string,"shortcut": string
                  }
                  Update: {
                    "body"?: string,"id"?: string,"org_id"?: string,"shortcut"?: string
                  }
                  Relationships: [
                    
                  ]
                },"templates": {
                  Row: {
                    "category": string,"channel_account_id": string,"components": NonNullable<Json>,"created_at": string,"created_by": string | null,"external_id": string | null,"id": string,"language": string,"name": string,"org_id": string,"quality": string | null,"rejection_reason": string | null,"status": string,"submitted_at": string | null,"updated_at": string
                  }
                  Insert: {
                    "category": string,"channel_account_id": string,"components"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"external_id"?: string | null,"id"?: string,"language"?: string,"name": string,"org_id": string,"quality"?: string | null,"rejection_reason"?: string | null,"status"?: string,"submitted_at"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "category"?: string,"channel_account_id"?: string,"components"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"external_id"?: string | null,"id"?: string,"language"?: string,"name"?: string,"org_id"?: string,"quality"?: string | null,"rejection_reason"?: string | null,"status"?: string,"submitted_at"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "templates_channel_account_id_fkey"
      columns: ["channel_account_id"]
isOneToOne: false
      referencedRelation: "channel_accounts"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_events": {
                  Row: {
                    "error": string | null,"event_key": string,"id": number,"payload": NonNullable<Json>,"processed_at": string | null,"provider": string,"received_at": string,"signature_valid": boolean
                  }
                  Insert: {
                    "error"?: string | null,"event_key": string,"id"?: never,"payload": NonNullable<Json>,"processed_at"?: string | null,"provider": string,"received_at"?: string,"signature_valid": boolean
                  }
                  Update: {
                    "error"?: string | null,"event_key"?: string,"id"?: never,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"provider"?: string,"received_at"?: string,"signature_valid"?: boolean
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_note":
{ Args: { "p_body": string,"p_conversation": string,"p_mentions"?: (string)[] }; Returns: {
              "body": string,
"conversation_id": string,
"created_at": string,
"id": string,
"member_id": string,
"mentions": (string)[],
"org_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "internal_notes"
        isOneToOne: true
        isSetofReturn: false
      } },
"after_hours_followup":
{ Args: { "p_conversation": string }; Returns: string
                           },
"apply_ai_result":
{ Args: { "p": Json,"p_conversation": string,"p_expected_version": number,"p_run": string }; Returns: Json
                           },
"assign_conversation":
{ Args: { "p_conversation": string,"p_member"?: string }; Returns: {
              "ai_instruction": string | null,
"ai_paused_until": string | null,
"assignee_member_id": string | null,
"channel_account_id": string,
"channel_identity_id": string,
"closed_at": string | null,
"closed_by": string | null,
"created_at": string,
"deal_id": string | null,
"human_agent_window_expires_at": string | null,
"id": string,
"intent": string | null,
"last_inbound_at": string | null,
"last_message_at": string | null,
"mode": Database["omni"]['Enums']["conv_mode"],
"org_id": string,
"outcome": string | null,
"outcome_note": string | null,
"outcome_source": string | null,
"party_id": string,
"pending_ai_at": string | null,
"persona_id": string | null,
"priority": number,
"sentiment": string | null,
"service_window_expires_at": string | null,
"sla_alerted_at": string | null,
"sla_due_at": string | null,
"status": string,
"summary": string | null,
"tags": (string)[],
"topics": (string)[],
"unread_count": number,
"updated_at": string,
"version": number,
"window_alerted_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "conversations"
        isOneToOne: true
        isSetofReturn: false
      } },
"attach_media":
{ Args: { "p_message": string,"p_path": string,"p_transcript"?: string }; Returns: undefined
                           },
"check_send_window":
{ Args: { "p_author": string,"p_conversation": string }; Returns: {
              "allowed": boolean,"mode": string,"reason": string
            }[]
                           },
"claim_router":
{ Args: { "p_conversation": string,"p_message": string }; Returns: Json
                           },
"close_conversation":
{ Args: { "p_conversation": string,"p_note"?: string,"p_outcome": string }; Returns: {
              "ai_instruction": string | null,
"ai_paused_until": string | null,
"assignee_member_id": string | null,
"channel_account_id": string,
"channel_identity_id": string,
"closed_at": string | null,
"closed_by": string | null,
"created_at": string,
"deal_id": string | null,
"human_agent_window_expires_at": string | null,
"id": string,
"intent": string | null,
"last_inbound_at": string | null,
"last_message_at": string | null,
"mode": Database["omni"]['Enums']["conv_mode"],
"org_id": string,
"outcome": string | null,
"outcome_note": string | null,
"outcome_source": string | null,
"party_id": string,
"pending_ai_at": string | null,
"persona_id": string | null,
"priority": number,
"sentiment": string | null,
"service_window_expires_at": string | null,
"sla_alerted_at": string | null,
"sla_due_at": string | null,
"status": string,
"summary": string | null,
"tags": (string)[],
"topics": (string)[],
"unread_count": number,
"updated_at": string,
"version": number,
"window_alerted_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "conversations"
        isOneToOne: true
        isSetofReturn: false
      } },
"csat_summary":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"delete_automation":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_quick_reply":
{ Args: { "p_id": string }; Returns: undefined
                           },
"delete_template":
{ Args: { "p_id": string }; Returns: undefined
                           },
"discard_draft":
{ Args: { "p_draft": string,"p_reason": string }; Returns: undefined
                           },
"fail_template_submission":
{ Args: { "p_id": string,"p_reason": string }; Returns: undefined
                           },
"ingest_event":
{ Args: { "p": Json }; Returns: Json
                           },
"ingest_webhook":
{ Args: { "p_event_key": string,"p_payload": Json,"p_provider": string }; Returns: Json
                           },
"mark_outbound":
{ Args: { "p_error"?: string,"p_message": string,"p_provider_message_id"?: string,"p_status": string }; Returns: undefined
                           },
"mark_read":
{ Args: { "p_conversation": string }; Returns: undefined
                           },
"nps_summary":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"open_conversation_for":
{ Args: { "p_party": string }; Returns: string
                           },
"outbound_context":
{ Args: { "p_message": string }; Returns: Json
                           },
"outcomes":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "conversations": number,"outcome": string,"source": string
            }[]
                           },
"pause_ai":
{ Args: { "p_conversation": string,"p_minutes": number }; Returns: {
              "ai_instruction": string | null,
"ai_paused_until": string | null,
"assignee_member_id": string | null,
"channel_account_id": string,
"channel_identity_id": string,
"closed_at": string | null,
"closed_by": string | null,
"created_at": string,
"deal_id": string | null,
"human_agent_window_expires_at": string | null,
"id": string,
"intent": string | null,
"last_inbound_at": string | null,
"last_message_at": string | null,
"mode": Database["omni"]['Enums']["conv_mode"],
"org_id": string,
"outcome": string | null,
"outcome_note": string | null,
"outcome_source": string | null,
"party_id": string,
"pending_ai_at": string | null,
"persona_id": string | null,
"priority": number,
"sentiment": string | null,
"service_window_expires_at": string | null,
"sla_alerted_at": string | null,
"sla_due_at": string | null,
"status": string,
"summary": string | null,
"tags": (string)[],
"topics": (string)[],
"unread_count": number,
"updated_at": string,
"version": number,
"window_alerted_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "conversations"
        isOneToOne: true
        isSetofReturn: false
      } },
"performance":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"queue_system_message":
{ Args: { "p_body": string,"p_conversation": string }; Returns: string
                           },
"record_opt_out":
{ Args: { "p_message": string,"p_party": string }; Returns: undefined
                           },
"record_template_status":
{ Args: { "p": Json }; Returns: string
                           },
"report_satisfaction":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "csat_answered": number,"csat_asked": number,"csat_avg": number,"month": string,"nps": number,"nps_answered": number,"nps_asked": number
            }[]
                           },
"request_template_sync":
{ Args: { "p_account": string }; Returns: undefined
                           },
"return_to_ai":
{ Args: { "p_conversation": string,"p_instruction"?: string,"p_mode": Database["omni"]['Enums']["conv_mode"] }; Returns: {
              "ai_instruction": string | null,
"ai_paused_until": string | null,
"assignee_member_id": string | null,
"channel_account_id": string,
"channel_identity_id": string,
"closed_at": string | null,
"closed_by": string | null,
"created_at": string,
"deal_id": string | null,
"human_agent_window_expires_at": string | null,
"id": string,
"intent": string | null,
"last_inbound_at": string | null,
"last_message_at": string | null,
"mode": Database["omni"]['Enums']["conv_mode"],
"org_id": string,
"outcome": string | null,
"outcome_note": string | null,
"outcome_source": string | null,
"party_id": string,
"pending_ai_at": string | null,
"persona_id": string | null,
"priority": number,
"sentiment": string | null,
"service_window_expires_at": string | null,
"sla_alerted_at": string | null,
"sla_due_at": string | null,
"status": string,
"summary": string | null,
"tags": (string)[],
"topics": (string)[],
"unread_count": number,
"updated_at": string,
"version": number,
"window_alerted_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "conversations"
        isOneToOne: true
        isSetofReturn: false
      } },
"run_automations":
{ Args: { "p_message": string,"p_referral"?: Json }; Returns: Json
                           },
"save_automation":
{ Args: { "p": Json }; Returns: {
              "actions": NonNullable<Json>,
"active": boolean,
"channel_account_id": string | null,
"conditions": NonNullable<Json>,
"cooldown_days": number,
"created_at": string,
"created_by": string | null,
"id": string,
"last_run_at": string | null,
"name": string,
"org_id": string,
"priority": number,
"trigger": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "automations"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_channel_account":
{ Args: { "p": Json }; Returns: {
              "business_hours": NonNullable<Json>,
"channel": Database["omni"]['Enums']["channel"],
"connection_id": string | null,
"created_at": string,
"default_ai_mode": Database["omni"]['Enums']["conv_mode"],
"default_persona_id": string | null,
"display_name": string,
"id": string,
"org_id": string,
"provider_account_id": string,
"public_address": string | null,
"status": string,
"store_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "channel_accounts"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_csat_settings":
{ Args: { "p": Json }; Returns: Json
                           },
"save_notice_rule":
{ Args: { "p": Json }; Returns: {
              "active": boolean,
"channel_account_id": string | null,
"event": string,
"free_text": string,
"id": string,
"org_id": string,
"task_fallback": boolean,
"template_id": string | null,
"template_vars": NonNullable<Json>,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "notice_rules"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_nps_settings":
{ Args: { "p": Json }; Returns: Json
                           },
"save_quick_reply":
{ Args: { "p_body": string,"p_id"?: string,"p_shortcut": string }; Returns: {
              "body": string,
"id": string,
"org_id": string,
"shortcut": string
            }
                          SetofOptions: {
        from: "*"
        to: "quick_replies"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_routing_settings":
{ Args: { "p": Json }; Returns: Json
                           },
"save_template":
{ Args: { "p": Json }; Returns: {
              "category": string,
"channel_account_id": string,
"components": NonNullable<Json>,
"created_at": string,
"created_by": string | null,
"external_id": string | null,
"id": string,
"language": string,
"name": string,
"org_id": string,
"quality": string | null,
"rejection_reason": string | null,
"status": string,
"submitted_at": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "templates"
        isOneToOne: true
        isSetofReturn: false
      } },
"send_message":
{ Args: { "p_body": string,"p_conversation": string,"p_draft"?: string,"p_edited"?: boolean }; Returns: {
              "ai_run_id": string | null,
"author_member_id": string | null,
"author_type": string,
"body": string | null,
"channel_account_id": string,
"client_dedupe_key": string | null,
"conversation_id": string,
"created_at": string,
"direction": string,
"error": string | null,
"id": string,
"media_path": string | null,
"org_id": string,
"payload": NonNullable<Json>,
"provider_message_id": string | null,
"reply_to_id": string | null,
"sent_at": string | null,
"seq": number,
"status": string,
"template_name": string | null,
"transcript": string | null,
"type": string
            }
                          SetofOptions: {
        from: "*"
        to: "messages"
        isOneToOne: true
        isSetofReturn: false
      } },
"send_template":
{ Args: { "p_conversation": string,"p_params"?: Json,"p_template": string }; Returns: {
              "ai_run_id": string | null,
"author_member_id": string | null,
"author_type": string,
"body": string | null,
"channel_account_id": string,
"client_dedupe_key": string | null,
"conversation_id": string,
"created_at": string,
"direction": string,
"error": string | null,
"id": string,
"media_path": string | null,
"org_id": string,
"payload": NonNullable<Json>,
"provider_message_id": string | null,
"reply_to_id": string | null,
"sent_at": string | null,
"seq": number,
"status": string,
"template_name": string | null,
"transcript": string | null,
"type": string
            }
                          SetofOptions: {
        from: "*"
        to: "messages"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_automation_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: {
              "actions": NonNullable<Json>,
"active": boolean,
"channel_account_id": string | null,
"conditions": NonNullable<Json>,
"cooldown_days": number,
"created_at": string,
"created_by": string | null,
"id": string,
"last_run_at": string | null,
"name": string,
"org_id": string,
"priority": number,
"trigger": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "automations"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_business_hours":
{ Args: { "p": Json,"p_id": string }; Returns: {
              "business_hours": NonNullable<Json>,
"channel": Database["omni"]['Enums']["channel"],
"connection_id": string | null,
"created_at": string,
"default_ai_mode": Database["omni"]['Enums']["conv_mode"],
"default_persona_id": string | null,
"display_name": string,
"id": string,
"org_id": string,
"provider_account_id": string,
"public_address": string | null,
"status": string,
"store_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "channel_accounts"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_channel_public_address":
{ Args: { "p_address": string,"p_id": string }; Returns: {
              "business_hours": NonNullable<Json>,
"channel": Database["omni"]['Enums']["channel"],
"connection_id": string | null,
"created_at": string,
"default_ai_mode": Database["omni"]['Enums']["conv_mode"],
"default_persona_id": string | null,
"display_name": string,
"id": string,
"org_id": string,
"provider_account_id": string,
"public_address": string | null,
"status": string,
"store_id": string | null,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "channel_accounts"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_mode":
{ Args: { "p_conversation": string,"p_mode": Database["omni"]['Enums']["conv_mode"],"p_reason"?: string }; Returns: {
              "ai_instruction": string | null,
"ai_paused_until": string | null,
"assignee_member_id": string | null,
"channel_account_id": string,
"channel_identity_id": string,
"closed_at": string | null,
"closed_by": string | null,
"created_at": string,
"deal_id": string | null,
"human_agent_window_expires_at": string | null,
"id": string,
"intent": string | null,
"last_inbound_at": string | null,
"last_message_at": string | null,
"mode": Database["omni"]['Enums']["conv_mode"],
"org_id": string,
"outcome": string | null,
"outcome_note": string | null,
"outcome_source": string | null,
"party_id": string,
"pending_ai_at": string | null,
"persona_id": string | null,
"priority": number,
"sentiment": string | null,
"service_window_expires_at": string | null,
"sla_alerted_at": string | null,
"sla_due_at": string | null,
"status": string,
"summary": string | null,
"tags": (string)[],
"topics": (string)[],
"unread_count": number,
"updated_at": string,
"version": number,
"window_alerted_at": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "conversations"
        isOneToOne: true
        isSetofReturn: false
      } },
"submit_template":
{ Args: { "p_id": string }; Returns: undefined
                           },
"suggest_outcome":
{ Args: { "p_conversation": string }; Returns: string
                           },
"sweep_sla":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"sweep_windows":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"test_automation":
{ Args: { "p_id": string,"p_text": string }; Returns: boolean
                           },
"topics_report":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "conversations": number,"negative": number,"topic": string
            }[]
                           },
"upsert_remote_template":
{ Args: { "p": Json }; Returns: string
                           }
          }
          Enums: {
            "channel": "WHATSAPP"|"INSTAGRAM"|"TELEGRAM"|"TIKTOK","conv_mode": "AI_AUTOPILOT"|"AI_COPILOT"|"HUMAN"|"WAITING_HUMAN"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"purch": {
          Tables: {
            "payment_terms": {
                  Row: {
                    "active": boolean,"id": string,"installments": NonNullable<Json>,"name": string,"org_id": string
                  }
                  Insert: {
                    "active"?: boolean,"id"?: string,"installments"?: NonNullable<Json>,"name": string,"org_id": string
                  }
                  Update: {
                    "active"?: boolean,"id"?: string,"installments"?: NonNullable<Json>,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"po_items": {
                  Row: {
                    "id": string,"org_id": string,"po_id": string,"qty_ordered": number,"qty_received": number,"unit_cost": number,"variant_id": string
                  }
                  Insert: {
                    "id"?: string,"org_id": string,"po_id": string,"qty_ordered": number,"qty_received"?: number,"unit_cost": number,"variant_id": string
                  }
                  Update: {
                    "id"?: string,"org_id"?: string,"po_id"?: string,"qty_ordered"?: number,"qty_received"?: number,"unit_cost"?: number,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "po_items_po_id_fkey"
      columns: ["po_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id"]
    }
                  ]
                },"purchase_orders": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"cancelled_reason": string | null,"collection_id": string | null,"created_at": string,"created_by": string | null,"expected_date": string | null,"id": string,"legal_entity_id": string,"location_id": string,"notes": string | null,"number": string,"org_id": string,"payment_terms_id": string | null,"status": string,"store_id": string | null,"supplier_party_id": string,"total": number,"updated_at": string
                  }
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"cancelled_reason"?: string | null,"collection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"expected_date"?: string | null,"id"?: string,"legal_entity_id": string,"location_id": string,"notes"?: string | null,"number": string,"org_id": string,"payment_terms_id"?: string | null,"status"?: string,"store_id"?: string | null,"supplier_party_id": string,"total"?: number,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"cancelled_reason"?: string | null,"collection_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"expected_date"?: string | null,"id"?: string,"legal_entity_id"?: string,"location_id"?: string,"notes"?: string | null,"number"?: string,"org_id"?: string,"payment_terms_id"?: string | null,"status"?: string,"store_id"?: string | null,"supplier_party_id"?: string,"total"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_orders_payment_terms_id_fkey"
      columns: ["payment_terms_id"]
isOneToOne: false
      referencedRelation: "payment_terms"
      referencedColumns: ["id"]
    }
                  ]
                },"receipt_items": {
                  Row: {
                    "cean": string | null,"cfop": string | null,"description": string | null,"id": string,"item_total": number,"landed_unit_cost": number | null,"match_confidence": number | null,"match_status": string,"movement_id": number | null,"n_item": number,"ncm": string | null,"org_id": string,"qty_counted": number | null,"qty_nfe": number,"receipt_id": string,"supplier_cprod": string | null,"unit": string | null,"unit_cost_nfe": number | null,"variant_id": string | null
                  }
                  Insert: {
                    "cean"?: string | null,"cfop"?: string | null,"description"?: string | null,"id"?: string,"item_total": number,"landed_unit_cost"?: number | null,"match_confidence"?: number | null,"match_status"?: string,"movement_id"?: number | null,"n_item": number,"ncm"?: string | null,"org_id": string,"qty_counted"?: number | null,"qty_nfe": number,"receipt_id": string,"supplier_cprod"?: string | null,"unit"?: string | null,"unit_cost_nfe"?: number | null,"variant_id"?: string | null
                  }
                  Update: {
                    "cean"?: string | null,"cfop"?: string | null,"description"?: string | null,"id"?: string,"item_total"?: number,"landed_unit_cost"?: number | null,"match_confidence"?: number | null,"match_status"?: string,"movement_id"?: number | null,"n_item"?: number,"ncm"?: string | null,"org_id"?: string,"qty_counted"?: number | null,"qty_nfe"?: number,"receipt_id"?: string,"supplier_cprod"?: string | null,"unit"?: string | null,"unit_cost_nfe"?: number | null,"variant_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "receipt_items_receipt_id_fkey"
      columns: ["receipt_id"]
isOneToOne: false
      referencedRelation: "receipts"
      referencedColumns: ["id"]
    }
                  ]
                },"receipts": {
                  Row: {
                    "checked_at": string | null,"checked_by": string | null,"created_at": string,"created_by": string | null,"credit_id": string | null,"document_id": string | null,"entry_id": string | null,"id": string,"landed_total": number | null,"legal_entity_id": string,"location_id": string,"nf_total": number,"notes": string | null,"number": string,"org_id": string,"po_id": string | null,"post_ref": string | null,"posted_at": string | null,"posted_by": string | null,"shortage_total": number,"status": string,"store_id": string | null,"supplier_party_id": string,"title_id": string | null
                  }
                  Insert: {
                    "checked_at"?: string | null,"checked_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"credit_id"?: string | null,"document_id"?: string | null,"entry_id"?: string | null,"id"?: string,"landed_total"?: number | null,"legal_entity_id": string,"location_id": string,"nf_total": number,"notes"?: string | null,"number": string,"org_id": string,"po_id"?: string | null,"post_ref"?: string | null,"posted_at"?: string | null,"posted_by"?: string | null,"shortage_total"?: number,"status"?: string,"store_id"?: string | null,"supplier_party_id": string,"title_id"?: string | null
                  }
                  Update: {
                    "checked_at"?: string | null,"checked_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"credit_id"?: string | null,"document_id"?: string | null,"entry_id"?: string | null,"id"?: string,"landed_total"?: number | null,"legal_entity_id"?: string,"location_id"?: string,"nf_total"?: number,"notes"?: string | null,"number"?: string,"org_id"?: string,"po_id"?: string | null,"post_ref"?: string | null,"posted_at"?: string | null,"posted_by"?: string | null,"shortage_total"?: number,"status"?: string,"store_id"?: string | null,"supplier_party_id"?: string,"title_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "receipts_po_id_fkey"
      columns: ["po_id"]
isOneToOne: false
      referencedRelation: "purchase_orders"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_suggestions":
{ Args: { "p_receipt": string }; Returns: number
                           },
"approve_po":
{ Args: { "p_po": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"cancelled_reason": string | null,
"collection_id": string | null,
"created_at": string,
"created_by": string | null,
"expected_date": string | null,
"id": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"payment_terms_id": string | null,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "purchase_orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"cancel_po":
{ Args: { "p_po": string,"p_reason": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"cancelled_reason": string | null,
"collection_id": string | null,
"created_at": string,
"created_by": string | null,
"expected_date": string | null,
"id": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"payment_terms_id": string | null,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "purchase_orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"close_po":
{ Args: { "p_po": string }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"cancelled_reason": string | null,
"collection_id": string | null,
"created_at": string,
"created_by": string | null,
"expected_date": string | null,
"id": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"payment_terms_id": string | null,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "purchase_orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"confirm_receipt":
{ Args: { "p_receipt": string }; Returns: {
              "checked_at": string | null,
"checked_by": string | null,
"created_at": string,
"created_by": string | null,
"credit_id": string | null,
"document_id": string | null,
"entry_id": string | null,
"id": string,
"landed_total": number | null,
"legal_entity_id": string,
"location_id": string,
"nf_total": number,
"notes": string | null,
"number": string,
"org_id": string,
"po_id": string | null,
"post_ref": string | null,
"posted_at": string | null,
"posted_by": string | null,
"shortage_total": number,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"title_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "receipts"
        isOneToOne: true
        isSetofReturn: false
      } },
"count_all":
{ Args: { "p_receipt": string }; Returns: number
                           },
"discard_receipt":
{ Args: { "p_receipt": string }; Returns: undefined
                           },
"ensure_supplier":
{ Args: { "p_cnpj": string,"p_name": string }; Returns: string
                           },
"import_nfe":
{ Args: { "p_location": string,"p_po"?: string,"p_xml": string }; Returns: {
              "checked_at": string | null,
"checked_by": string | null,
"created_at": string,
"created_by": string | null,
"credit_id": string | null,
"document_id": string | null,
"entry_id": string | null,
"id": string,
"landed_total": number | null,
"legal_entity_id": string,
"location_id": string,
"nf_total": number,
"notes": string | null,
"number": string,
"org_id": string,
"po_id": string | null,
"post_ref": string | null,
"posted_at": string | null,
"posted_by": string | null,
"shortage_total": number,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"title_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "receipts"
        isOneToOne: true
        isSetofReturn: false
      } },
"post_receipt":
{ Args: { "p_installments"?: Json,"p_receipt": string }; Returns: {
              "checked_at": string | null,
"checked_by": string | null,
"created_at": string,
"created_by": string | null,
"credit_id": string | null,
"document_id": string | null,
"entry_id": string | null,
"id": string,
"landed_total": number | null,
"legal_entity_id": string,
"location_id": string,
"nf_total": number,
"notes": string | null,
"number": string,
"org_id": string,
"po_id": string | null,
"post_ref": string | null,
"posted_at": string | null,
"posted_by": string | null,
"shortage_total": number,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"title_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "receipts"
        isOneToOne: true
        isSetofReturn: false
      } },
"replenishment":
{ Args: { "p_cover"?: number,"p_lead"?: number,"p_location": string,"p_lookback"?: number,"p_safety"?: number }; Returns: {
              "color": string,"days_cover": number,"last_cost": number,"on_hand": number,"on_order": number,"product_name": string,"reserved": number,"size": string,"sku": string,"sold": number,"suggested": number,"supplier_party_id": string,"target": number,"variant_id": string,"velocity": number
            }[]
                           },
"reverse_receipt":
{ Args: { "p_reason": string,"p_receipt": string }; Returns: {
              "checked_at": string | null,
"checked_by": string | null,
"created_at": string,
"created_by": string | null,
"credit_id": string | null,
"document_id": string | null,
"entry_id": string | null,
"id": string,
"landed_total": number | null,
"legal_entity_id": string,
"location_id": string,
"nf_total": number,
"notes": string | null,
"number": string,
"org_id": string,
"po_id": string | null,
"post_ref": string | null,
"posted_at": string | null,
"posted_by": string | null,
"shortage_total": number,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"title_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "receipts"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_po":
{ Args: { "p": Json }; Returns: {
              "approved_at": string | null,
"approved_by": string | null,
"cancelled_reason": string | null,
"collection_id": string | null,
"created_at": string,
"created_by": string | null,
"expected_date": string | null,
"id": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"payment_terms_id": string | null,
"status": string,
"store_id": string | null,
"supplier_party_id": string,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "purchase_orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_receipt_item":
{ Args: { "p": Json,"p_item": string }; Returns: {
              "cean": string | null,
"cfop": string | null,
"description": string | null,
"id": string,
"item_total": number,
"landed_unit_cost": number | null,
"match_confidence": number | null,
"match_status": string,
"movement_id": number | null,
"n_item": number,
"ncm": string | null,
"org_id": string,
"qty_counted": number | null,
"qty_nfe": number,
"receipt_id": string,
"supplier_cprod": string | null,
"unit": string | null,
"unit_cost_nfe": number | null,
"variant_id": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "receipt_items"
        isOneToOne: true
        isSetofReturn: false
      } }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"sales": {
          Tables: {
            "cash_registers": {
                  Row: {
                    "active": boolean,"device_id": string | null,"id": string,"name": string,"org_id": string,"store_id": string
                  }
                  Insert: {
                    "active"?: boolean,"device_id"?: string | null,"id"?: string,"name": string,"org_id": string,"store_id": string
                  }
                  Update: {
                    "active"?: boolean,"device_id"?: string | null,"id"?: string,"name"?: string,"org_id"?: string,"store_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"cash_session_movements": {
                  Row: {
                    "amount": number,"created_at": string,"created_by": string | null,"id": number,"order_id": string | null,"org_id": string,"reason": string | null,"session_id": string,"type": string
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"created_by"?: string | null,"id"?: never,"order_id"?: string | null,"org_id": string,"reason"?: string | null,"session_id": string,"type": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"created_by"?: string | null,"id"?: never,"order_id"?: string | null,"org_id"?: string,"reason"?: string | null,"session_id"?: string,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_session_movements_session_id_fkey"
      columns: ["session_id"]
isOneToOne: false
      referencedRelation: "cash_sessions"
      referencedColumns: ["id"]
    }
                  ]
                },"cash_sessions": {
                  Row: {
                    "closed_at": string | null,"closed_by": string | null,"counted_cash": number | null,"difference": number | null,"expected_cash": number | null,"id": string,"notes": string | null,"opened_at": string,"opened_by": string,"opening_float": number,"org_id": string,"register_id": string,"status": string,"store_id": string
                  }
                  Insert: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"counted_cash"?: number | null,"difference"?: number | null,"expected_cash"?: number | null,"id"?: string,"notes"?: string | null,"opened_at"?: string,"opened_by": string,"opening_float"?: number,"org_id": string,"register_id": string,"status"?: string,"store_id": string
                  }
                  Update: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"counted_cash"?: number | null,"difference"?: number | null,"expected_cash"?: number | null,"id"?: string,"notes"?: string | null,"opened_at"?: string,"opened_by"?: string,"opening_float"?: number,"org_id"?: string,"register_id"?: string,"status"?: string,"store_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "cash_sessions_register_id_fkey"
      columns: ["register_id"]
isOneToOne: false
      referencedRelation: "cash_registers"
      referencedColumns: ["id"]
    }
                  ]
                },"coupon_redemptions": {
                  Row: {
                    "amount": number,"coupon_id": string,"created_at": string,"id": string,"order_id": string,"org_id": string,"party_id": string | null
                  }
                  Insert: {
                    "amount": number,"coupon_id": string,"created_at"?: string,"id"?: string,"order_id": string,"org_id": string,"party_id"?: string | null
                  }
                  Update: {
                    "amount"?: number,"coupon_id"?: string,"created_at"?: string,"id"?: string,"order_id"?: string,"org_id"?: string,"party_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "coupon_redemptions_coupon_id_fkey"
      columns: ["coupon_id"]
isOneToOne: false
      referencedRelation: "coupons"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "coupon_redemptions_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"coupons": {
                  Row: {
                    "active": boolean,"affiliate_party_id": string | null,"code": string,"created_at": string,"id": string,"kind": string,"max_uses": number | null,"min_order": number | null,"org_id": string,"per_customer_limit": number | null,"valid_from": string,"valid_to": string | null,"value": number
                  }
                  Insert: {
                    "active"?: boolean,"affiliate_party_id"?: string | null,"code": string,"created_at"?: string,"id"?: string,"kind": string,"max_uses"?: number | null,"min_order"?: number | null,"org_id": string,"per_customer_limit"?: number | null,"valid_from"?: string,"valid_to"?: string | null,"value": number
                  }
                  Update: {
                    "active"?: boolean,"affiliate_party_id"?: string | null,"code"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"max_uses"?: number | null,"min_order"?: number | null,"org_id"?: string,"per_customer_limit"?: number | null,"valid_from"?: string,"valid_to"?: string | null,"value"?: number
                  }
                  Relationships: [
                    
                  ]
                },"locker_drops": {
                  Row: {
                    "closed_at": string | null,"dropped_at": string,"expires_at": string,"id": string,"locker_id": string,"notes": string | null,"order_id": string | null,"org_id": string,"outcome": string,"party_id": string | null,"prepared_by": string | null,"store_id": string
                  }
                  Insert: {
                    "closed_at"?: string | null,"dropped_at"?: string,"expires_at": string,"id"?: string,"locker_id": string,"notes"?: string | null,"order_id"?: string | null,"org_id": string,"outcome"?: string,"party_id"?: string | null,"prepared_by"?: string | null,"store_id": string
                  }
                  Update: {
                    "closed_at"?: string | null,"dropped_at"?: string,"expires_at"?: string,"id"?: string,"locker_id"?: string,"notes"?: string | null,"order_id"?: string | null,"org_id"?: string,"outcome"?: string,"party_id"?: string | null,"prepared_by"?: string | null,"store_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "locker_drops_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"order_credits": {
                  Row: {
                    "member_id": string | null,"order_id": string,"org_id": string,"role": string,"share_pct": number
                  }
                  Insert: {
                    "member_id"?: string | null,"order_id": string,"org_id": string,"role": string,"share_pct": number
                  }
                  Update: {
                    "member_id"?: string | null,"order_id"?: string,"org_id"?: string,"role"?: string,"share_pct"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_credits_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"order_items": {
                  Row: {
                    "cfop": string | null,"commissionable": boolean,"csosn": string | null,"discount_amount": number,"discount_reason": string | null,"id": string,"line_no": number,"list_price": number,"ncm": string | null,"order_id": string,"org_id": string,"qty": number,"reservation_id": string | null,"returned_qty": number,"total": number,"unit_cost_snapshot": number | null,"unit_price": number,"variant_id": string
                  }
                  Insert: {
                    "cfop"?: string | null,"commissionable"?: boolean,"csosn"?: string | null,"discount_amount"?: number,"discount_reason"?: string | null,"id"?: string,"line_no"?: never,"list_price": number,"ncm"?: string | null,"order_id": string,"org_id": string,"qty": number,"reservation_id"?: string | null,"returned_qty"?: number,"total": number,"unit_cost_snapshot"?: number | null,"unit_price": number,"variant_id": string
                  }
                  Update: {
                    "cfop"?: string | null,"commissionable"?: boolean,"csosn"?: string | null,"discount_amount"?: number,"discount_reason"?: string | null,"id"?: string,"line_no"?: never,"list_price"?: number,"ncm"?: string | null,"order_id"?: string,"org_id"?: string,"qty"?: number,"reservation_id"?: string | null,"returned_qty"?: number,"total"?: number,"unit_cost_snapshot"?: number | null,"unit_price"?: number,"variant_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "order_items_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"orders": {
                  Row: {
                    "assisted_by_ai": boolean,"attribution": NonNullable<Json>,"cash_session_id": string | null,"channel": Database["sales"]['Enums']["channel"],"completed_at": string | null,"cost_total": number,"coupon_id": string | null,"cpf_on_invoice": string | null,"created_at": string,"created_by": string | null,"customer_confirmed_message_id": string | null,"discount_total": number,"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],"id": string,"idempotency_key": string,"legal_entity_id": string,"location_id": string,"notes": string | null,"number": string,"org_id": string,"origin_conversation_id": string | null,"paid_total": number,"party_id": string | null,"price_list_id": string | null,"profit_cost_center_id": string | null,"seller_member_id": string | null,"shipping_total": number,"status": Database["sales"]['Enums']["order_status"],"store_id": string,"subtotal": number,"total": number,"updated_at": string
                  }
                  Insert: {
                    "assisted_by_ai"?: boolean,"attribution"?: NonNullable<Json>,"cash_session_id"?: string | null,"channel": Database["sales"]['Enums']["channel"],"completed_at"?: string | null,"cost_total"?: number,"coupon_id"?: string | null,"cpf_on_invoice"?: string | null,"created_at"?: string,"created_by"?: string | null,"customer_confirmed_message_id"?: string | null,"discount_total"?: number,"fulfillment_type"?: Database["sales"]['Enums']["fulfillment_type"],"id"?: string,"idempotency_key": string,"legal_entity_id": string,"location_id": string,"notes"?: string | null,"number": string,"org_id": string,"origin_conversation_id"?: string | null,"paid_total"?: number,"party_id"?: string | null,"price_list_id"?: string | null,"profit_cost_center_id"?: string | null,"seller_member_id"?: string | null,"shipping_total"?: number,"status"?: Database["sales"]['Enums']["order_status"],"store_id": string,"subtotal"?: number,"total"?: number,"updated_at"?: string
                  }
                  Update: {
                    "assisted_by_ai"?: boolean,"attribution"?: NonNullable<Json>,"cash_session_id"?: string | null,"channel"?: Database["sales"]['Enums']["channel"],"completed_at"?: string | null,"cost_total"?: number,"coupon_id"?: string | null,"cpf_on_invoice"?: string | null,"created_at"?: string,"created_by"?: string | null,"customer_confirmed_message_id"?: string | null,"discount_total"?: number,"fulfillment_type"?: Database["sales"]['Enums']["fulfillment_type"],"id"?: string,"idempotency_key"?: string,"legal_entity_id"?: string,"location_id"?: string,"notes"?: string | null,"number"?: string,"org_id"?: string,"origin_conversation_id"?: string | null,"paid_total"?: number,"party_id"?: string | null,"price_list_id"?: string | null,"profit_cost_center_id"?: string | null,"seller_member_id"?: string | null,"shipping_total"?: number,"status"?: Database["sales"]['Enums']["order_status"],"store_id"?: string,"subtotal"?: number,"total"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "orders_cash_session_id_fkey"
      columns: ["cash_session_id"]
isOneToOne: false
      referencedRelation: "cash_sessions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "orders_coupon_id_fkey"
      columns: ["coupon_id"]
isOneToOne: false
      referencedRelation: "coupons"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_links": {
                  Row: {
                    "amount": number,"created_at": string,"expires_at": string | null,"external_id": string | null,"id": string,"max_installments": number,"order_id": string,"org_id": string,"provider": string,"sent_message_id": string | null,"status": string,"url": string | null
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"expires_at"?: string | null,"external_id"?: string | null,"id"?: string,"max_installments"?: number,"order_id": string,"org_id": string,"provider": string,"sent_message_id"?: string | null,"status"?: string,"url"?: string | null
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"expires_at"?: string | null,"external_id"?: string | null,"id"?: string,"max_installments"?: number,"order_id"?: string,"org_id"?: string,"provider"?: string,"sent_message_id"?: string | null,"status"?: string,"url"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_links_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "acquirer": string | null,"acquirer_connection_id": string | null,"amount": number,"anticipation_mode": string | null,"auth_code": string | null,"brand": string | null,"created_at": string,"external_id": string | null,"fee_expected": number | null,"fee_rate_expected": number | null,"id": string,"installments": number,"last4": string | null,"method": Database["sales"]['Enums']["payment_method"],"net_expected": number | null,"nsu": string | null,"order_id": string,"org_id": string,"status": string,"terminal_id": string | null
                  }
                  Insert: {
                    "acquirer"?: string | null,"acquirer_connection_id"?: string | null,"amount": number,"anticipation_mode"?: string | null,"auth_code"?: string | null,"brand"?: string | null,"created_at"?: string,"external_id"?: string | null,"fee_expected"?: number | null,"fee_rate_expected"?: number | null,"id"?: string,"installments"?: number,"last4"?: string | null,"method": Database["sales"]['Enums']["payment_method"],"net_expected"?: number | null,"nsu"?: string | null,"order_id": string,"org_id": string,"status"?: string,"terminal_id"?: string | null
                  }
                  Update: {
                    "acquirer"?: string | null,"acquirer_connection_id"?: string | null,"amount"?: number,"anticipation_mode"?: string | null,"auth_code"?: string | null,"brand"?: string | null,"created_at"?: string,"external_id"?: string | null,"fee_expected"?: number | null,"fee_rate_expected"?: number | null,"id"?: string,"installments"?: number,"last4"?: string | null,"method"?: Database["sales"]['Enums']["payment_method"],"net_expected"?: number | null,"nsu"?: string | null,"order_id"?: string,"org_id"?: string,"status"?: string,"terminal_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"return_items": {
                  Row: {
                    "id": string,"order_item_id": string,"org_id": string,"qty": number,"restock_location_id": string | null,"return_id": string
                  }
                  Insert: {
                    "id"?: string,"order_item_id": string,"org_id": string,"qty": number,"restock_location_id"?: string | null,"return_id": string
                  }
                  Update: {
                    "id"?: string,"order_item_id"?: string,"org_id"?: string,"qty"?: number,"restock_location_id"?: string | null,"return_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "return_items_order_item_id_fkey"
      columns: ["order_item_id"]
isOneToOne: false
      referencedRelation: "order_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "return_items_return_id_fkey"
      columns: ["return_id"]
isOneToOne: false
      referencedRelation: "returns"
      referencedColumns: ["id"]
    }
                  ]
                },"returns": {
                  Row: {
                    "amount": number,"cogs_amount": number,"created_at": string,"created_by": string | null,"entry_id": string | null,"exchange_order_id": string | null,"fiscal_document_id": string | null,"id": string,"notes": string | null,"number": string,"order_id": string,"org_id": string,"party_id": string | null,"reason": string,"refund_method": string | null,"refund_title_id": string | null,"type": string
                  }
                  Insert: {
                    "amount"?: number,"cogs_amount"?: number,"created_at"?: string,"created_by"?: string | null,"entry_id"?: string | null,"exchange_order_id"?: string | null,"fiscal_document_id"?: string | null,"id"?: string,"notes"?: string | null,"number": string,"order_id": string,"org_id": string,"party_id"?: string | null,"reason": string,"refund_method"?: string | null,"refund_title_id"?: string | null,"type": string
                  }
                  Update: {
                    "amount"?: number,"cogs_amount"?: number,"created_at"?: string,"created_by"?: string | null,"entry_id"?: string | null,"exchange_order_id"?: string | null,"fiscal_document_id"?: string | null,"id"?: string,"notes"?: string | null,"number"?: string,"order_id"?: string,"org_id"?: string,"party_id"?: string | null,"reason"?: string,"refund_method"?: string | null,"refund_title_id"?: string | null,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "returns_exchange_order_id_fkey"
      columns: ["exchange_order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "returns_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"shipments": {
                  Row: {
                    "address": NonNullable<Json>,"carrier": string,"charged": number,"cost": number,"created_at": string,"created_by": string | null,"delivered_at": string | null,"id": string,"label_url": string | null,"notes": string | null,"order_id": string,"org_id": string,"shipped_at": string | null,"status": string,"tracking": string | null
                  }
                  Insert: {
                    "address"?: NonNullable<Json>,"carrier": string,"charged"?: number,"cost"?: number,"created_at"?: string,"created_by"?: string | null,"delivered_at"?: string | null,"id"?: string,"label_url"?: string | null,"notes"?: string | null,"order_id": string,"org_id": string,"shipped_at"?: string | null,"status"?: string,"tracking"?: string | null
                  }
                  Update: {
                    "address"?: NonNullable<Json>,"carrier"?: string,"charged"?: number,"cost"?: number,"created_at"?: string,"created_by"?: string | null,"delivered_at"?: string | null,"id"?: string,"label_url"?: string | null,"notes"?: string | null,"order_id"?: string,"org_id"?: string,"shipped_at"?: string | null,"status"?: string,"tracking"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "shipments_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "orders"
      referencedColumns: ["id"]
    }
                  ]
                },"store_credit_ledger": {
                  Row: {
                    "amount": number,"created_at": string,"created_by": string | null,"expires_at": string | null,"id": number,"org_id": string,"party_id": string,"reason": string,"source_id": string | null,"source_type": string | null
                  }
                  Insert: {
                    "amount": number,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: never,"org_id": string,"party_id": string,"reason": string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: never,"org_id"?: string,"party_id"?: string,"reason"?: string,"source_id"?: string | null,"source_type"?: string | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "cancel_order":
{ Args: { "p_order": string,"p_reason": string }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"cash_movement":
{ Args: { "p_amount": number,"p_reason": string,"p_session": string,"p_type": string }; Returns: undefined
                           },
"cash_session_expected":
{ Args: { "p_session": string }; Returns: number
                           },
"close_cash_session":
{ Args: { "p_counted": number,"p_notes"?: string,"p_session": string }; Returns: {
              "closed_at": string | null,
"closed_by": string | null,
"counted_cash": number | null,
"difference": number | null,
"expected_cash": number | null,
"id": string,
"notes": string | null,
"opened_at": string,
"opened_by": string,
"opening_float": number,
"org_id": string,
"register_id": string,
"status": string,
"store_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "cash_sessions"
        isOneToOne: true
        isSetofReturn: false
      } },
"close_locker_drop":
{ Args: { "p_drop": string,"p_order"?: string,"p_outcome": string }; Returns: {
              "closed_at": string | null,
"dropped_at": string,
"expires_at": string,
"id": string,
"locker_id": string,
"notes": string | null,
"order_id": string | null,
"org_id": string,
"outcome": string,
"party_id": string | null,
"prepared_by": string | null,
"store_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "locker_drops"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_payment_link":
{ Args: { "p_max_installments"?: number,"p_order": string,"p_provider"?: string }; Returns: {
              "amount": number,
"created_at": string,
"expires_at": string | null,
"external_id": string | null,
"id": string,
"max_installments": number,
"order_id": string,
"org_id": string,
"provider": string,
"sent_message_id": string | null,
"status": string,
"url": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "payment_links"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_pos_order":
{ Args: { "p": Json }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_remote_order":
{ Args: { "p": Json }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_return":
{ Args: { "p": Json }; Returns: {
              "amount": number,
"cogs_amount": number,
"created_at": string,
"created_by": string | null,
"entry_id": string | null,
"exchange_order_id": string | null,
"fiscal_document_id": string | null,
"id": string,
"notes": string | null,
"number": string,
"order_id": string,
"org_id": string,
"party_id": string | null,
"reason": string,
"refund_method": string | null,
"refund_title_id": string | null,
"type": string
            }
                          SetofOptions: {
        from: "*"
        to: "returns"
        isOneToOne: true
        isSetofReturn: false
      } },
"expire_locker_drops":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"expire_pending_orders":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"finalize_order":
{ Args: { "p_order": string }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"link_exchange":
{ Args: { "p_order": string,"p_return": string }; Returns: undefined
                           },
"open_cash_session":
{ Args: { "p_opening_float": number,"p_register": string }; Returns: {
              "closed_at": string | null,
"closed_by": string | null,
"counted_cash": number | null,
"difference": number | null,
"expected_cash": number | null,
"id": string,
"notes": string | null,
"opened_at": string,
"opened_by": string,
"opening_float": number,
"org_id": string,
"register_id": string,
"status": string,
"store_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "cash_sessions"
        isOneToOne: true
        isSetofReturn: false
      } },
"prepare_locker":
{ Args: { "p": Json }; Returns: {
              "closed_at": string | null,
"dropped_at": string,
"expires_at": string,
"id": string,
"locker_id": string,
"notes": string | null,
"order_id": string | null,
"org_id": string,
"outcome": string,
"party_id": string | null,
"prepared_by": string | null,
"store_id": string
            }
                          SetofOptions: {
        from: "*"
        to: "locker_drops"
        isOneToOne: true
        isSetofReturn: false
      } },
"register_payment":
{ Args: { "p": Json }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"report_abc":
{ Args: { "p_by": string,"p_from": string,"p_to": string }; Returns: Json
                           },
"report_cohorts":
{ Args: { "p_months"?: number }; Returns: {
              "back_180": number,"back_30": number,"back_60": number,"back_90": number,"cohort": string,"customers": number
            }[]
                           },
"report_recovered":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "attempts": number,"kind": string,"recovered": number,"revenue": number
            }[]
                           },
"report_sales":
{ Args: { "p_from": string,"p_group": string,"p_to": string }; Returns: Json
                           },
"save_shipment":
{ Args: { "p": Json }; Returns: {
              "address": NonNullable<Json>,
"carrier": string,
"charged": number,
"cost": number,
"created_at": string,
"created_by": string | null,
"delivered_at": string | null,
"id": string,
"label_url": string | null,
"notes": string | null,
"order_id": string,
"org_id": string,
"shipped_at": string | null,
"status": string,
"tracking": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "shipments"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_order_status":
{ Args: { "p_order": string,"p_status": string }; Returns: {
              "assisted_by_ai": boolean,
"attribution": NonNullable<Json>,
"cash_session_id": string | null,
"channel": Database["sales"]['Enums']["channel"],
"completed_at": string | null,
"cost_total": number,
"coupon_id": string | null,
"cpf_on_invoice": string | null,
"created_at": string,
"created_by": string | null,
"customer_confirmed_message_id": string | null,
"discount_total": number,
"fulfillment_type": Database["sales"]['Enums']["fulfillment_type"],
"id": string,
"idempotency_key": string,
"legal_entity_id": string,
"location_id": string,
"notes": string | null,
"number": string,
"org_id": string,
"origin_conversation_id": string | null,
"paid_total": number,
"party_id": string | null,
"price_list_id": string | null,
"profit_cost_center_id": string | null,
"seller_member_id": string | null,
"shipping_total": number,
"status": Database["sales"]['Enums']["order_status"],
"store_id": string,
"subtotal": number,
"total": number,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "orders"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_payment_link":
{ Args: { "p_external_id": string,"p_link": string,"p_url": string }; Returns: undefined
                           },
"store_credit_balance":
{ Args: { "p_party": string }; Returns: number
                           },
"validate_coupon":
{ Args: { "p_code": string,"p_party"?: string,"p_subtotal": number }; Returns: Json
                           }
          }
          Enums: {
            "channel": "POS"|"WHATSAPP"|"INSTAGRAM"|"TELEGRAM"|"TIKTOK"|"PAYMENT_LINK"|"B2B"|"EVENT","fulfillment_type": "TAKEAWAY"|"LOCKER_PICKUP"|"STORE_PICKUP"|"MOTOBOY"|"CARRIER","order_status": "DRAFT"|"CONFIRMED"|"PENDING_PAYMENT"|"PAID"|"FULFILLING"|"READY_FOR_PICKUP"|"SHIPPED"|"COMPLETED"|"CANCELLED"|"PARTIALLY_RETURNED"|"RETURNED","payment_method": "PIX"|"DEBIT"|"CREDIT"|"CASH"|"PAYMENT_LINK"|"BOLETO"|"STORE_CREDIT"|"PERMUTA"|"B2B_INVOICE"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "aff": {
          Enums: {
            
          }
        },"ai": {
          Enums: {
            
          }
        },"catalog": {
          Enums: {
            "assortment_class": ["CORE", "DROP", "ACCESSORY"],"gender": ["FEM", "MASC", "UNISSEX"],"product_kind": ["GOODS", "SERVICE", "GIFT_WRAP", "FEE"],"product_status": ["DRAFT", "ACTIVE", "DISCONTINUED"]
          }
        },"comm": {
          Enums: {
            
          }
        },"core": {
          Enums: {
            "cost_center_kind": ["CORPORATE", "LEGAL_ENTITY", "STORE", "CHANNEL", "PROJECT_EVENT", "POOL"],"legal_entity_kind": ["OPERATING", "HOLDING"],"store_format": ["SHOP_IN_SHOP", "CONSIGNMENT_CORNER", "POPUP", "DIGITAL", "WAREHOUSE", "B2B"],"store_status": ["PLANNED", "ACTIVE", "CLOSED"]
          }
        },"crm": {
          Enums: {
            "consent_purpose": ["TRANSACTIONAL", "MARKETING_WHATSAPP", "MARKETING_EMAIL", "MARKETING_IG", "AI_PROFILING", "ENRICHMENT", "IMAGE_USE"],"contact_type": ["PHONE", "EMAIL", "WHATSAPP", "INSTAGRAM", "TELEGRAM", "TIKTOK"],"legal_basis": ["CONSENT", "LEGITIMATE_INTEREST", "CONTRACT", "LEGAL_OBLIGATION"],"lifecycle_stage": ["LEAD", "PROSPECT", "CUSTOMER", "VIP", "INACTIVE", "LOST"],"party_kind": ["PERSON", "COMPANY"],"party_role": ["CUSTOMER", "SUPPLIER", "EMPLOYEE", "AFFILIATE_TRAINER", "PARTNER_GYM", "INFLUENCER", "CARRIER", "SERVICE_PROVIDER", "SHAREHOLDER", "ACQUIRER", "BANK"],"tier": ["STANDARD", "VIP", "VIP_BLACK"]
          }
        },"fin": {
          Enums: {
            "account_group": ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "DEDUCTION", "COGS", "EXPENSE", "FINANCIAL"],"title_direction": ["RECEIVABLE", "PAYABLE"],"title_status": ["OPEN", "PARTIAL", "SETTLED", "CANCELLED", "RENEGOTIATED"]
          }
        },"fiscal": {
          Enums: {
            
          }
        },"hr": {
          Enums: {
            
          }
        },"inv": {
          Enums: {
            "location_kind": ["SALES_FLOOR", "BACKROOM", "VIP_LOCKERS", "IN_TRANSIT", "CONSIGNMENT_AT_PARTNER", "POPUP", "DAMAGED", "MARKETING"],"movement_type": ["INITIAL_BALANCE", "PURCHASE_RECEIPT", "SALE", "SALE_RETURN", "EXCHANGE_IN", "EXCHANGE_OUT", "TRANSFER_OUT", "TRANSFER_IN", "COUNT_ADJUST", "LOSS", "DAMAGE", "SPONSORSHIP_IN_KIND", "MARKETING_GIFT", "CONSIGNMENT_OUT", "CONSIGNMENT_RETURN", "SUPPLIER_RETURN"]
          }
        },"mkt": {
          Enums: {
            
          }
        },"omni": {
          Enums: {
            "channel": ["WHATSAPP", "INSTAGRAM", "TELEGRAM", "TIKTOK"],"conv_mode": ["AI_AUTOPILOT", "AI_COPILOT", "HUMAN", "WAITING_HUMAN"]
          }
        },"purch": {
          Enums: {
            
          }
        },"sales": {
          Enums: {
            "channel": ["POS", "WHATSAPP", "INSTAGRAM", "TELEGRAM", "TIKTOK", "PAYMENT_LINK", "B2B", "EVENT"],"fulfillment_type": ["TAKEAWAY", "LOCKER_PICKUP", "STORE_PICKUP", "MOTOBOY", "CARRIER"],"order_status": ["DRAFT", "CONFIRMED", "PENDING_PAYMENT", "PAID", "FULFILLING", "READY_FOR_PICKUP", "SHIPPED", "COMPLETED", "CANCELLED", "PARTIALLY_RETURNED", "RETURNED"],"payment_method": ["PIX", "DEBIT", "CREDIT", "CASH", "PAYMENT_LINK", "BOLETO", "STORE_CREDIT", "PERMUTA", "B2B_INVOICE"]
          }
        }
} as const

