-- =====================================================================
-- Consentimento para anúncios: só quem aceitou entra num público personalizado da Meta (LGPD).
-- Fica numa migration própria porque um valor novo de enum só pode ser usado depois que a transação que o criou termina.
-- =====================================================================
alter type crm.consent_purpose add value if not exists 'MARKETING_ADS';
