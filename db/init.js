function createInit({ pool }) {
  async function initDatabase() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_settings (
          id INTEGER PRIMARY KEY,
          graph_api_access_token TEXT,
          contact_token TEXT,
          venice_api_key TEXT,
          venice_model TEXT,
          system_prompt TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const alter = async (sql) =>
        client.query(sql).catch((e) => {
          console.warn('[DB][ALTER][SKIP]', { sql, code: e?.code, message: e?.message });
        });

      const botSettingsCols = [
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_min_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_max_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_max_wait_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_debug BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_max_msgs INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_ttl_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_debug_debounce BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_late_join_window_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_preview_text_max_len INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_provider TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_api_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_max_output_tokens INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_reasoning_effort TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_api_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_temperature DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_max_tokens INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_timeout_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_stream BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_user_message TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_search TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_include_venice_system_prompt BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_citations BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_scraping BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_api_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_api_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_temperature DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_max_tokens INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_grok_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_api_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_ai_provider TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_openai_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_venice_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_max_out_messages INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_config TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_generic TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_parse TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS elevenlabs_api_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_voice_id TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_model_id TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_output_format TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_stability DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_similarity_boost DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_style DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_use_speaker_boost BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_system_prompt TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_user_prompt TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_temperature DOUBLE PRECISION;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_max_tokens INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_timeout_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_history_max_items INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_history_max_chars INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_script_max_chars INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_fallback_text TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS pix_gateway_default TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_secret TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_create_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_callback_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_webhook_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_api_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_client_id TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_client_secret TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_callback_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_webhook_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_api_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_api_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_create_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_callback_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_webhook_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS safepix_api_base_url TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS safepix_public_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS safepix_secret_key TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS safepix_create_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS safepix_webhook_path TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_enabled BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_model TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_language TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_prompt TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_timeout_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_audio_enabled BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_audio_after_msgs INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS utmify_api_token TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS meta_ads_access_token TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS meta_ads_ad_account_id TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS meta_ads_api_version TEXT;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS meta_ads_timeout_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS meta_ads_cache_ttl_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS audio_rl_enabled BOOLEAN;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS audio_rl_max INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS audio_rl_window_ms INTEGER;`,
        `ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS audio_rl_notice_text TEXT;`,
      ];
      for (const s of botSettingsCols) await alter(s);

      const delayCols = [
        'ai_in_delay_base_min_ms', 'ai_in_delay_base_max_ms', 'ai_in_delay_per_char_min_ms', 'ai_in_delay_per_char_max_ms',
        'ai_in_delay_cap_ms', 'ai_in_delay_jitter_min_ms', 'ai_in_delay_jitter_max_ms', 'ai_in_delay_total_min_ms', 'ai_in_delay_total_max_ms',
        'ai_out_delay_base_min_ms', 'ai_out_delay_base_max_ms', 'ai_out_delay_per_char_min_ms', 'ai_out_delay_per_char_max_ms',
        'ai_out_delay_cap_ms', 'ai_out_delay_jitter_min_ms', 'ai_out_delay_jitter_max_ms', 'ai_out_delay_total_min_ms', 'ai_out_delay_total_max_ms',
      ];
      for (const c of delayCols) await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ${c} INTEGER;`);

      await client.query(`INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

      await client.query(`
        UPDATE bot_settings
           SET inbound_debounce_min_ms = COALESCE(inbound_debounce_min_ms, 1800),
               inbound_debounce_max_ms = COALESCE(inbound_debounce_max_ms, 3200),
               inbound_max_wait_ms     = COALESCE(inbound_max_wait_ms, 12000),
               ai_debug = COALESCE(ai_debug, TRUE),
               lead_max_msgs = COALESCE(lead_max_msgs, 50),
               lead_ttl_ms = COALESCE(lead_ttl_ms, 604800000),
               lead_debug_debounce = COALESCE(lead_debug_debounce, TRUE),
               lead_late_join_window_ms = COALESCE(lead_late_join_window_ms, 350),
               lead_preview_text_max_len = COALESCE(lead_preview_text_max_len, 80),
               ai_provider = COALESCE(ai_provider, 'venice'),
               openai_model = COALESCE(openai_model, 'gpt-5'),
               openai_max_output_tokens = COALESCE(openai_max_output_tokens, 1200),
               openai_reasoning_effort = COALESCE(openai_reasoning_effort, 'low'),
               venice_api_url = COALESCE(venice_api_url, 'https://api.venice.ai/api/v1/chat/completions'),
               venice_temperature = COALESCE(venice_temperature, 0.7),
               venice_max_tokens = COALESCE(venice_max_tokens, 700),
               venice_timeout_ms = COALESCE(venice_timeout_ms, 60000),
               venice_stream = COALESCE(venice_stream, FALSE),
               venice_user_message = COALESCE(venice_user_message, 'Responda exatamente no formato JSON especificado.'),
               venice_enable_web_search = COALESCE(venice_enable_web_search, 'off'),
               venice_include_venice_system_prompt = COALESCE(venice_include_venice_system_prompt, FALSE),
               venice_enable_web_citations = COALESCE(venice_enable_web_citations, FALSE),
               venice_enable_web_scraping = COALESCE(venice_enable_web_scraping, FALSE),
               grok_api_url = COALESCE(grok_api_url, 'https://api.x.ai/v1/chat/completions'),
               grok_temperature = COALESCE(grok_temperature, 0.7),
               grok_max_tokens = COALESCE(grok_max_tokens, 700),
               openai_api_url = COALESCE(openai_api_url, 'https://api.openai.com/v1/responses'),
               ai_max_out_messages = COALESCE(ai_max_out_messages, 3),
               ai_error_msg_config = COALESCE(ai_error_msg_config, 'Config incompleta no painel (venice key/model/prompt).'),
               ai_error_msg_generic = COALESCE(ai_error_msg_generic, 'Tive um erro aqui. Manda de novo?'),
               ai_error_msg_parse = COALESCE(ai_error_msg_parse, 'Não entendi direito. Me manda de novo?'),
               ai_in_delay_base_min_ms = COALESCE(ai_in_delay_base_min_ms, 900),
               ai_in_delay_base_max_ms = COALESCE(ai_in_delay_base_max_ms, 1800),
               ai_in_delay_per_char_min_ms = COALESCE(ai_in_delay_per_char_min_ms, 18),
               ai_in_delay_per_char_max_ms = COALESCE(ai_in_delay_per_char_max_ms, 45),
               ai_in_delay_cap_ms = COALESCE(ai_in_delay_cap_ms, 5200),
               ai_in_delay_jitter_min_ms = COALESCE(ai_in_delay_jitter_min_ms, 400),
               ai_in_delay_jitter_max_ms = COALESCE(ai_in_delay_jitter_max_ms, 1600),
               ai_in_delay_total_min_ms = COALESCE(ai_in_delay_total_min_ms, 1600),
               ai_in_delay_total_max_ms = COALESCE(ai_in_delay_total_max_ms, 9500),
               ai_out_delay_base_min_ms = COALESCE(ai_out_delay_base_min_ms, 450),
               ai_out_delay_base_max_ms = COALESCE(ai_out_delay_base_max_ms, 1200),
               ai_out_delay_per_char_min_ms = COALESCE(ai_out_delay_per_char_min_ms, 22),
               ai_out_delay_per_char_max_ms = COALESCE(ai_out_delay_per_char_max_ms, 55),
               ai_out_delay_cap_ms = COALESCE(ai_out_delay_cap_ms, 6500),
               ai_out_delay_jitter_min_ms = COALESCE(ai_out_delay_jitter_min_ms, 250),
               ai_out_delay_jitter_max_ms = COALESCE(ai_out_delay_jitter_max_ms, 1200),
               ai_out_delay_total_min_ms = COALESCE(ai_out_delay_total_min_ms, 900),
               ai_out_delay_total_max_ms = COALESCE(ai_out_delay_total_max_ms, 12000),
               eleven_model_id = COALESCE(eleven_model_id, 'eleven_v3'),
               eleven_output_format = COALESCE(eleven_output_format, 'ogg_opus'),
               eleven_use_speaker_boost = COALESCE(eleven_use_speaker_boost, FALSE),
               voice_note_temperature = COALESCE(voice_note_temperature, 0.85),
               voice_note_max_tokens = COALESCE(voice_note_max_tokens, 220),
               voice_note_timeout_ms = COALESCE(voice_note_timeout_ms, 45000),
               voice_note_history_max_items = COALESCE(voice_note_history_max_items, 10),
               voice_note_history_max_chars = COALESCE(voice_note_history_max_chars, 1600),
               voice_note_script_max_chars = COALESCE(voice_note_script_max_chars, 650),
               pix_gateway_default = COALESCE(pix_gateway_default, 'veltrax'),
               rapdyn_api_base_url = COALESCE(rapdyn_api_base_url, ''),
               rapdyn_create_path = COALESCE(rapdyn_create_path, '/v1/pix'),
               rapdyn_callback_base_url = COALESCE(rapdyn_callback_base_url, ''),
               rapdyn_webhook_path = COALESCE(rapdyn_webhook_path, '/webhook/rapdyn'),
               veltrax_api_base_url = COALESCE(veltrax_api_base_url, 'https://api.veltraxpay.com'),
               veltrax_callback_base_url = COALESCE(veltrax_callback_base_url, ''),
               veltrax_webhook_path = COALESCE(veltrax_webhook_path, '/webhook/veltrax'),
               zoompag_api_base_url = COALESCE(zoompag_api_base_url, 'https://api.zoompag.com'),
               zoompag_create_path = COALESCE(zoompag_create_path, '/transactions'),
               zoompag_webhook_path = COALESCE(zoompag_webhook_path, '/webhook/zoompag'),
               safepix_api_base_url = COALESCE(safepix_api_base_url, 'https://api.safepix.pro'),
               safepix_create_path  = COALESCE(safepix_create_path, '/v1/payment-transactions/create'),
               safepix_webhook_path = COALESCE(safepix_webhook_path, '/webhook/safepix'),
               openai_transcribe_enabled = COALESCE(openai_transcribe_enabled, TRUE),
               openai_transcribe_model = COALESCE(openai_transcribe_model, 'whisper-1'),
               openai_transcribe_language = COALESCE(openai_transcribe_language, 'pt'),
               openai_transcribe_prompt = COALESCE(openai_transcribe_prompt, ''),
               openai_transcribe_timeout_ms = COALESCE(openai_transcribe_timeout_ms, 60000),
               auto_audio_enabled = COALESCE(auto_audio_enabled, FALSE),
               auto_audio_after_msgs = COALESCE(auto_audio_after_msgs, 12),
               utmify_api_token = COALESCE(utmify_api_token, ''),
               meta_ads_api_version = COALESCE(meta_ads_api_version, 'v23.0'),
               meta_ads_timeout_ms = COALESCE(meta_ads_timeout_ms, 15000),
               meta_ads_cache_ttl_ms = COALESCE(meta_ads_cache_ttl_ms, 3600000),
               audio_rl_enabled = COALESCE(audio_rl_enabled, FALSE),
               audio_rl_max = COALESCE(audio_rl_max, 30),
               audio_rl_window_ms = COALESCE(audio_rl_window_ms, 3600000),
               audio_rl_notice_text = COALESCE(audio_rl_notice_text, ''),
               updated_at = NOW()
         WHERE id = 1;
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS bot_meta_numbers (
          id SERIAL PRIMARY KEY,
          phone_number_id VARCHAR(50) NOT NULL UNIQUE,
          display_phone_number VARCHAR(50),
          access_token TEXT NOT NULL,
          label TEXT,
          active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS veltrax_deposits (
          id SERIAL PRIMARY KEY,
          wa_id VARCHAR(32) NOT NULL,
          offer_id TEXT,
          amount NUMERIC(12,2) NOT NULL,
          external_id TEXT NOT NULL UNIQUE,
          transaction_id TEXT UNIQUE,
          status TEXT DEFAULT 'PENDING',
          payer_name TEXT,
          payer_email TEXT,
          payer_document TEXT,
          payer_phone TEXT,
          fee NUMERIC(12,2),
          net_amount NUMERIC(12,2),
          end_to_end TEXT,
          raw_webhook JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS fulfillment_offers (
          id SERIAL PRIMARY KEY,
          offer_id TEXT NOT NULL UNIQUE,
          title TEXT,
          kind TEXT NOT NULL,
          enabled BOOLEAN DEFAULT TRUE,
          pre_text TEXT,
          post_text TEXT,
          delay_min_ms INTEGER DEFAULT 30000,
          delay_max_ms INTEGER DEFAULT 45000,
          delay_between_min_ms INTEGER DEFAULT 250,
          delay_between_max_ms INTEGER DEFAULT 900,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await alter(`ALTER TABLE fulfillment_offers ADD COLUMN IF NOT EXISTS title TEXT;`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS fulfillment_media (
          id SERIAL PRIMARY KEY,
          offer_id TEXT NOT NULL REFERENCES fulfillment_offers(offer_id) ON DELETE CASCADE,
          pos INTEGER NOT NULL DEFAULT 0,
          url TEXT NOT NULL,
          caption TEXT,
          active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_fulfillment_media_offer_pos ON fulfillment_media (offer_id, pos);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_fulfillment_media_offer_active ON fulfillment_media (offer_id, active);`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_offers (
          id SERIAL PRIMARY KEY,
          preview_id TEXT NOT NULL UNIQUE,
          title TEXT,
          kind TEXT NOT NULL,
          enabled BOOLEAN DEFAULT TRUE,
          pre_text TEXT,
          post_text TEXT,
          delay_min_ms INTEGER DEFAULT 30000,
          delay_max_ms INTEGER DEFAULT 45000,
          delay_between_min_ms INTEGER DEFAULT 250,
          delay_between_max_ms INTEGER DEFAULT 900,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_media (
          id SERIAL PRIMARY KEY,
          preview_id TEXT NOT NULL REFERENCES preview_offers(preview_id) ON DELETE CASCADE,
          pos INTEGER NOT NULL DEFAULT 0,
          url TEXT NOT NULL,
          caption TEXT,
          active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_preview_media_preview_pos ON preview_media (preview_id, pos);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_preview_media_preview_active ON preview_media (preview_id, active);`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS fulfillment_deliveries (
          id SERIAL PRIMARY KEY,
          provider TEXT,
          external_id TEXT NOT NULL,
          transaction_id TEXT,
          wa_id VARCHAR(32) NOT NULL,
          offer_id TEXT,
          status TEXT DEFAULT 'STARTED',
          attempts INTEGER DEFAULT 0,
          last_error TEXT,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          delivered_at TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await alter(`ALTER TABLE fulfillment_media DROP CONSTRAINT IF EXISTS fulfillment_media_offer_id_fkey;`);
      await alter(`
        ALTER TABLE fulfillment_media
        ADD CONSTRAINT fulfillment_media_offer_id_fkey
        FOREIGN KEY (offer_id)
        REFERENCES fulfillment_offers(offer_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE;
      `);

      await alter(`DROP INDEX IF EXISTS ux_fulfillment_deliveries_external_id;`);
      await alter(`CREATE UNIQUE INDEX IF NOT EXISTS ux_fulfillment_deliveries_provider_external_id ON fulfillment_deliveries (provider, external_id);`);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_fulfillment_deliveries_wa_offer ON fulfillment_deliveries (wa_id, offer_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_fulfillment_deliveries_status ON fulfillment_deliveries (status);`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS pix_deposits (
          id SERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          wa_id VARCHAR(32) NOT NULL,
          offer_id TEXT,
          amount NUMERIC(12,2) NOT NULL,
          external_id TEXT NOT NULL,
          transaction_id TEXT,
          status TEXT DEFAULT 'PENDING',
          payer_name TEXT,
          payer_email TEXT,
          payer_document TEXT,
          payer_phone TEXT,
          fee NUMERIC(12,2),
          net_amount NUMERIC(12,2),
          end_to_end TEXT,
          qrcode TEXT,
          raw_create_response JSONB,
          raw_webhook JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (provider, external_id)
        );
      `);

      await alter(`ALTER TABLE pix_deposits DROP CONSTRAINT IF EXISTS pix_deposits_external_id_key;`);
      await alter(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_deposits_provider_external_id ON pix_deposits (provider, external_id);`);
      await alter(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_deposits_provider_transaction_id ON pix_deposits (provider, transaction_id) WHERE transaction_id IS NOT NULL;`);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_wa_offer ON pix_deposits (wa_id, offer_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_status ON pix_deposits (status);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_provider ON pix_deposits (provider);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_transaction_id ON pix_deposits (transaction_id);`);

      await client.query(`CREATE INDEX IF NOT EXISTS idx_veltrax_deposits_wa_offer ON veltrax_deposits (wa_id, offer_id);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_veltrax_deposits_status ON veltrax_deposits (status);`);

      await client.query('COMMIT');
      console.log('[DB] Tabelas OK.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { });
      console.error('[DB][INIT][ERROR]', { code: err?.code, message: err?.message, detail: err?.detail, where: err?.where });
      throw err;
    } finally {
      client.release();
    }
  }

  return { initDatabase };
}

module.exports = { createInit };
