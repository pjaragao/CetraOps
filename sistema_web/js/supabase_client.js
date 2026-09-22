/**
 * CetraOps / SIÉ Joy OS - Supabase Frontend Client Helper
 * Fornece utilitários para verificação de status e sincronização com o Supabase.
 */

const SupabaseBridge = {
    async getStatus() {
        try {
            const res = await fetch('/api/supabase/status');
            return await res.json();
        } catch (err) {
            console.warn('[SupabaseBridge] Falha ao obter status:', err);
            return { configured: false, error: err.message };
        }
    },

    async testConnection() {
        try {
            const res = await fetch('/api/supabase/test', { method: 'POST' });
            return await res.json();
        } catch (err) {
            return { success: false, message: err.message };
        }
    },

    async triggerSync() {
        try {
            const res = await fetch('/api/supabase/sync', { method: 'POST' });
            return await res.json();
        } catch (err) {
            return { success: false, error: err.message };
        }
    }
};

if (typeof window !== 'undefined') {
    window.SupabaseBridge = SupabaseBridge;
}
