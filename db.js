const { Pool } = require('pg');

let _settingsCache = null;
let _settingsCacheTs = 0;
const SETTINGS_TTL_MS = 60_000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  keepAlive: true,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT || 5000),
});

pool.on('error', (err) => {
  console.error('[PG][POOL][ERROR]', { code: err?.code, message: err?.message });
});

function toIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function toFloatOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

function toBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return null;
}

function clampInt(n, { min, max } = {}) {
  if (!Number.isFinite(n)) return null;
  let x = Math.trunc(n);
  if (Number.isFinite(min)) x = Math.max(min, x);
  if (Number.isFinite(max)) x = Math.min(max, x);
  return x;
}

function clampFloat(n, { min, max } = {}) {
  if (!Number.isFinite(n)) return null;
  let x = n;
  if (Number.isFinite(min)) x = Math.max(min, x);
  if (Number.isFinite(max)) x = Math.min(max, x);
  return x;
}

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1) garante tabela principal (mesmo que mínima)
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

    // 2) garante colunas em bancos antigos (NÃO engole silenciosamente: loga aviso)
    const alter = async (sql) =>
      client.query(sql).catch((e) => {
        console.warn('[DB][ALTER][SKIP]', { sql, code: e?.code, message: e?.message });
      });

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_min_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_max_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_max_wait_ms INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_debug BOOLEAN;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_max_msgs INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_ttl_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_debug_debounce BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_late_join_window_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_preview_text_max_len INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_provider TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_api_key TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_model TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_max_output_tokens INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_reasoning_effort TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_api_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_temperature DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_max_tokens INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_timeout_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_stream BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_user_message TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_search TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_include_venice_system_prompt BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_citations BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS venice_enable_web_scraping BOOLEAN;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_api_key TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_model TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_api_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_temperature DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS grok_max_tokens INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_grok_model TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_api_url TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_ai_provider TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_openai_model TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_venice_model TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_max_out_messages INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_config TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_generic TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_error_msg_parse TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS elevenlabs_api_key TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_voice_id TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_model_id TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_output_format TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_stability DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_similarity_boost DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_style DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS eleven_use_speaker_boost BOOLEAN;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_system_prompt TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_user_prompt TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_temperature DOUBLE PRECISION;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_max_tokens INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_timeout_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_history_max_items INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_history_max_chars INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_script_max_chars INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS voice_note_fallback_text TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS pix_gateway_default TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_key TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_api_secret TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_create_path TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_callback_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS rapdyn_webhook_path TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_api_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_client_id TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_client_secret TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_callback_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS veltrax_webhook_path TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_api_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_api_key TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_create_path TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_callback_base_url TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS zoompag_webhook_path TEXT;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_enabled BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_model TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_language TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_prompt TEXT;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS openai_transcribe_timeout_ms INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_audio_enabled BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_audio_after_msgs INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS utmify_api_token TEXT;`);

    const delayCols = [
      'ai_in_delay_base_min_ms', 'ai_in_delay_base_max_ms', 'ai_in_delay_per_char_min_ms', 'ai_in_delay_per_char_max_ms',
      'ai_in_delay_cap_ms', 'ai_in_delay_jitter_min_ms', 'ai_in_delay_jitter_max_ms', 'ai_in_delay_total_min_ms', 'ai_in_delay_total_max_ms',
      'ai_out_delay_base_min_ms', 'ai_out_delay_base_max_ms', 'ai_out_delay_per_char_min_ms', 'ai_out_delay_per_char_max_ms',
      'ai_out_delay_cap_ms', 'ai_out_delay_jitter_min_ms', 'ai_out_delay_jitter_max_ms', 'ai_out_delay_total_min_ms', 'ai_out_delay_total_max_ms',
    ];
    for (const c of delayCols) {
      await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ${c} INTEGER;`);
    }

    // 3) garante singleton id=1
    await client.query(`
      INSERT INTO bot_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4) defaults (APENAS UMA VEZ, e com vírgulas corretas)
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

             openai_transcribe_enabled = COALESCE(openai_transcribe_enabled, TRUE),
             openai_transcribe_model = COALESCE(openai_transcribe_model, 'whisper-1'),
             openai_transcribe_language = COALESCE(openai_transcribe_language, 'pt'),
             openai_transcribe_prompt = COALESCE(openai_transcribe_prompt, ''),
             openai_transcribe_timeout_ms = COALESCE(openai_transcribe_timeout_ms, 60000),

             auto_audio_enabled = COALESCE(auto_audio_enabled, FALSE),
             auto_audio_after_msgs = COALESCE(auto_audio_after_msgs, 12),

             utmify_api_token = COALESCE(utmify_api_token, ''),

             updated_at = NOW()
       WHERE id = 1;
    `);

    // 5) meta numbers
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

    // 6) veltrax deposits
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
  CREATE TABLE IF NOT EXISTS pix_deposits (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    wa_id VARCHAR(32) NOT NULL,
    offer_id TEXT,
    amount NUMERIC(12,2) NOT NULL,
    external_id TEXT NOT NULL UNIQUE,
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_wa_offer ON pix_deposits (wa_id, offer_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_status ON pix_deposits (status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_provider ON pix_deposits (provider);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pix_deposits_transaction_id ON pix_deposits (transaction_id);`);


    await client.query(`CREATE INDEX IF NOT EXISTS idx_veltrax_deposits_wa_offer ON veltrax_deposits (wa_id, offer_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_veltrax_deposits_status ON veltrax_deposits (status);`);

    await client.query('COMMIT');
    console.log('[DB] Tabelas (bot_settings, bot_meta_numbers) OK.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('[DB][INIT][ERROR]', {
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
      where: err?.where,
    });
    throw err;
  } finally {
    client.release();
  }
}

async function getBotSettings({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && _settingsCache && now - _settingsCacheTs < SETTINGS_TTL_MS) {
    return _settingsCache;
  }

  const { rows } = await pool.query(`
    SELECT
      id,
      graph_api_access_token,
      contact_token,
      venice_api_key,
      venice_model,
      system_prompt,

      inbound_debounce_min_ms,
      inbound_debounce_max_ms,
      inbound_max_wait_ms,

      ai_debug,

      lead_max_msgs,
      lead_ttl_ms,
      lead_debug_debounce,
      lead_late_join_window_ms,
      lead_preview_text_max_len,

      ai_provider,
      openai_api_key,
      openai_model,
      openai_max_output_tokens,
      openai_reasoning_effort,

      venice_api_url,
      venice_temperature,
      venice_max_tokens,
      venice_timeout_ms,
      venice_stream,
      venice_user_message,

      venice_enable_web_search,
      venice_include_venice_system_prompt,
      venice_enable_web_citations,
      venice_enable_web_scraping,

      grok_api_key,
      grok_model,
      grok_api_url,
      grok_temperature,
      grok_max_tokens,

      voice_note_grok_model,

      openai_api_url,

      voice_note_ai_provider,
      voice_note_openai_model,
      voice_note_venice_model,

      ai_max_out_messages,
      ai_error_msg_config,
      ai_error_msg_generic,
      ai_error_msg_parse,

      ai_in_delay_base_min_ms,
      ai_in_delay_base_max_ms,
      ai_in_delay_per_char_min_ms,
      ai_in_delay_per_char_max_ms,
      ai_in_delay_cap_ms,
      ai_in_delay_jitter_min_ms,
      ai_in_delay_jitter_max_ms,
      ai_in_delay_total_min_ms,
      ai_in_delay_total_max_ms,

      ai_out_delay_base_min_ms,
      ai_out_delay_base_max_ms,
      ai_out_delay_per_char_min_ms,
      ai_out_delay_per_char_max_ms,
      ai_out_delay_cap_ms,
      ai_out_delay_jitter_min_ms,
      ai_out_delay_jitter_max_ms,
      ai_out_delay_total_min_ms,
      ai_out_delay_total_max_ms,

      elevenlabs_api_key,
      eleven_voice_id,
      eleven_model_id,
      eleven_output_format,
      eleven_stability,
      eleven_similarity_boost,
      eleven_style,
      eleven_use_speaker_boost,

      voice_note_system_prompt,
      voice_note_user_prompt,
      voice_note_temperature,
      voice_note_max_tokens,
      voice_note_timeout_ms,
      voice_note_history_max_items,
      voice_note_history_max_chars,
      voice_note_script_max_chars,
      voice_note_fallback_text,

      pix_gateway_default,
      rapdyn_api_base_url,
      rapdyn_api_key,
      rapdyn_api_secret,
      rapdyn_create_path,
      rapdyn_callback_base_url,
      rapdyn_webhook_path,

      veltrax_api_base_url,
      veltrax_client_id,
      veltrax_client_secret,
      veltrax_callback_base_url,
      veltrax_webhook_path,

      zoompag_api_base_url,
      zoompag_api_key,
      zoompag_create_path,
      zoompag_callback_base_url,
      zoompag_webhook_path,

      openai_transcribe_enabled,
      openai_transcribe_model,
      openai_transcribe_language,
      openai_transcribe_prompt,
      openai_transcribe_timeout_ms,

      auto_audio_enabled,
      auto_audio_after_msgs,

      utmify_api_token,

      updated_at
    FROM bot_settings
    WHERE id = 1
    LIMIT 1
  `);

  _settingsCache = rows[0] || { id: 1 };
  _settingsCacheTs = now;
  return _settingsCache;
}

async function updateBotSettings(payload) {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

    const {
      graph_api_access_token,
      contact_token,
      venice_api_key,
      venice_model,
      system_prompt,

      inbound_debounce_min_ms,
      inbound_debounce_max_ms,
      inbound_max_wait_ms,

      ai_debug,

      lead_max_msgs,
      lead_ttl_ms,
      lead_debug_debounce,
      lead_late_join_window_ms,
      lead_preview_text_max_len,

      ai_provider,

      openai_api_key,
      openai_model,
      openai_max_output_tokens,
      openai_reasoning_effort,

      venice_api_url,
      venice_temperature,
      venice_max_tokens,
      venice_timeout_ms,
      venice_stream,
      venice_user_message,

      venice_enable_web_search,
      venice_include_venice_system_prompt,
      venice_enable_web_citations,
      venice_enable_web_scraping,

      grok_api_key,
      grok_model,
      grok_api_url,
      grok_temperature,
      grok_max_tokens,

      voice_note_grok_model,

      openai_api_url,

      voice_note_ai_provider,
      voice_note_openai_model,
      voice_note_venice_model,

      ai_max_out_messages,
      ai_error_msg_config,
      ai_error_msg_generic,
      ai_error_msg_parse,

      ai_in_delay_base_min_ms,
      ai_in_delay_base_max_ms,
      ai_in_delay_per_char_min_ms,
      ai_in_delay_per_char_max_ms,
      ai_in_delay_cap_ms,
      ai_in_delay_jitter_min_ms,
      ai_in_delay_jitter_max_ms,
      ai_in_delay_total_min_ms,
      ai_in_delay_total_max_ms,

      ai_out_delay_base_min_ms,
      ai_out_delay_base_max_ms,
      ai_out_delay_per_char_min_ms,
      ai_out_delay_per_char_max_ms,
      ai_out_delay_cap_ms,
      ai_out_delay_jitter_min_ms,
      ai_out_delay_jitter_max_ms,
      ai_out_delay_total_min_ms,
      ai_out_delay_total_max_ms,

      elevenlabs_api_key,
      eleven_voice_id,
      eleven_model_id,
      eleven_output_format,
      eleven_stability,
      eleven_similarity_boost,
      eleven_style,
      eleven_use_speaker_boost,

      voice_note_system_prompt,
      voice_note_user_prompt,
      voice_note_temperature,
      voice_note_max_tokens,
      voice_note_timeout_ms,
      voice_note_history_max_items,
      voice_note_history_max_chars,
      voice_note_script_max_chars,
      voice_note_fallback_text,

      pix_gateway_default,
      rapdyn_api_base_url,
      rapdyn_api_key,
      rapdyn_api_secret,
      rapdyn_create_path,
      rapdyn_callback_base_url,
      rapdyn_webhook_path,

      veltrax_api_base_url,
      veltrax_client_id,
      veltrax_client_secret,
      veltrax_callback_base_url,
      veltrax_webhook_path,

      zoompag_api_base_url,
      zoompag_api_key,
      zoompag_create_path,
      zoompag_callback_base_url,
      zoompag_webhook_path,

      openai_transcribe_enabled,
      openai_transcribe_model,
      openai_transcribe_language,
      openai_transcribe_prompt,
      openai_transcribe_timeout_ms,

      auto_audio_enabled,
      auto_audio_after_msgs,

      utmify_api_token,

    } = payload;

    let dMin = clampInt(toIntOrNull(inbound_debounce_min_ms), { min: 200, max: 15000 });
    let dMax = clampInt(toIntOrNull(inbound_debounce_max_ms), { min: 200, max: 20000 });
    let maxW = clampInt(toIntOrNull(inbound_max_wait_ms), { min: 500, max: 60000 });

    if (Number.isFinite(dMin) && Number.isFinite(dMax) && dMin > dMax) {
      const tmp = dMin; dMin = dMax; dMax = tmp;
    }

    const aiDebug = toBoolOrNull(ai_debug);

    const leadMaxMsgs = clampInt(toIntOrNull(lead_max_msgs), { min: 5, max: 500 });
    const leadTtlMs = clampInt(toIntOrNull(lead_ttl_ms), { min: 60_000, max: 2_147_000_000 });
    const leadDebugDebounce = toBoolOrNull(lead_debug_debounce);
    const leadLateJoin = clampInt(toIntOrNull(lead_late_join_window_ms), { min: 0, max: 5000 });
    const leadPrevMax = clampInt(toIntOrNull(lead_preview_text_max_len), { min: 10, max: 500 });

    const vTemp = clampFloat(toFloatOrNull(venice_temperature), { min: 0, max: 2 });
    const vMaxTokens = clampInt(toIntOrNull(venice_max_tokens), { min: 16, max: 4096 });
    const vTimeout = clampInt(toIntOrNull(venice_timeout_ms), { min: 1000, max: 180000 });
    const vStream = toBoolOrNull(venice_stream);

    const webSearch = (venice_enable_web_search !== undefined && venice_enable_web_search !== null)
      ? (String(venice_enable_web_search).trim() || null)
      : null;

    const vIncSys = toBoolOrNull(venice_include_venice_system_prompt);
    const vCitations = toBoolOrNull(venice_enable_web_citations);
    const vScraping = toBoolOrNull(venice_enable_web_scraping);

    const maxOut = clampInt(toIntOrNull(ai_max_out_messages), { min: 1, max: 10 });

    function cDelay(v, min, max) {
      return clampInt(toIntOrNull(v), { min, max });
    }

    function toFloatOpt(v) {
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      if (!s) return null; // <-- evita '' virar 0
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return n;
    }

    const inBaseMin = cDelay(ai_in_delay_base_min_ms, 0, 20000);
    const inBaseMax = cDelay(ai_in_delay_base_max_ms, 0, 20000);
    const inPcMin = cDelay(ai_in_delay_per_char_min_ms, 0, 500);
    const inPcMax = cDelay(ai_in_delay_per_char_max_ms, 0, 500);
    const inCap = cDelay(ai_in_delay_cap_ms, 0, 60000);
    const inJMin = cDelay(ai_in_delay_jitter_min_ms, 0, 20000);
    const inJMax = cDelay(ai_in_delay_jitter_max_ms, 0, 20000);
    const inTMin = cDelay(ai_in_delay_total_min_ms, 0, 60000);
    const inTMax = cDelay(ai_in_delay_total_max_ms, 0, 60000);

    const outBaseMin = cDelay(ai_out_delay_base_min_ms, 0, 20000);
    const outBaseMax = cDelay(ai_out_delay_base_max_ms, 0, 20000);
    const outPcMin = cDelay(ai_out_delay_per_char_min_ms, 0, 500);
    const outPcMax = cDelay(ai_out_delay_per_char_max_ms, 0, 500);
    const outCap = cDelay(ai_out_delay_cap_ms, 0, 60000);
    const outJMin = cDelay(ai_out_delay_jitter_min_ms, 0, 20000);
    const outJMax = cDelay(ai_out_delay_jitter_max_ms, 0, 20000);
    const outTMin = cDelay(ai_out_delay_total_min_ms, 0, 60000);
    const outTMax = cDelay(ai_out_delay_total_max_ms, 0, 60000);

    const elevenApiKey = (elevenlabs_api_key || '').trim() || null;
    const elevenVoiceId = (eleven_voice_id || '').trim() || null;
    const elevenModelId = (eleven_model_id || '').trim() || null;
    const elevenOutputFormat = (eleven_output_format || '').trim() || null;

    const elevenStability = clampFloat(toFloatOpt(eleven_stability), { min: 0, max: 1 });
    const elevenSimilarity = clampFloat(toFloatOpt(eleven_similarity_boost), { min: 0, max: 1 });
    const elevenStyle = clampFloat(toFloatOpt(eleven_style), { min: 0, max: 1 });

    const elevenSpeakerBoost = toBoolOrNull(eleven_use_speaker_boost);

    const vnTemp = clampFloat(toFloatOrNull(voice_note_temperature), { min: 0, max: 2 });
    const vnMaxTokens = clampInt(toIntOrNull(voice_note_max_tokens), { min: 16, max: 4096 });
    const vnTimeout = clampInt(toIntOrNull(voice_note_timeout_ms), { min: 1000, max: 180000 });

    const vnHistItems = clampInt(toIntOrNull(voice_note_history_max_items), { min: 1, max: 50 });
    const vnHistChars = clampInt(toIntOrNull(voice_note_history_max_chars), { min: 200, max: 8000 });
    const vnScriptMaxChars = clampInt(toIntOrNull(voice_note_script_max_chars), { min: 200, max: 4000 });

    const pixGatewayDefaultRaw = String(pix_gateway_default || '').trim().toLowerCase();
    const pixGatewayDefault = (pixGatewayDefaultRaw === 'veltrax' || pixGatewayDefaultRaw === 'rapdyn' || pixGatewayDefaultRaw === 'zoompag') ? pixGatewayDefaultRaw : null;

    const rApiBase = (rapdyn_api_base_url || '').trim() || null;
    const rKey = (rapdyn_api_key || '').trim() || null;
    const rSecret = (rapdyn_api_secret || '').trim() || null;
    const rCreatePath = (rapdyn_create_path || '').trim() || null;
    const rCbBase = (rapdyn_callback_base_url || '').trim() || null;
    const rWebhookPath = (rapdyn_webhook_path || '').trim() || null;

    const vtxApiBase = (veltrax_api_base_url || '').trim() || null;
    const vtxClientId = (veltrax_client_id || '').trim() || null;
    const vtxClientSecret = (veltrax_client_secret || '').trim() || null;
    const vtxCbBase = (veltrax_callback_base_url || '').trim() || null;
    const vtxWebhookPath = (veltrax_webhook_path || '').trim() || null;

    const zApiBase = (zoompag_api_base_url || '').trim() || null;
    const zKey = (zoompag_api_key || '').trim() || null;
    const zCreatePath = (zoompag_create_path || '').trim() || null;
    const zCbBase = (zoompag_callback_base_url || '').trim() || null;
    const zWebhookPath = (zoompag_webhook_path || '').trim() || null;

    const aiProviderRaw = (ai_provider || '').trim().toLowerCase();
    const aiProvider = (aiProviderRaw === 'venice' || aiProviderRaw === 'openai' || aiProviderRaw === 'grok') ? aiProviderRaw : null;

    const openaiApiKey = (openai_api_key || '').trim() || null;
    const openaiModel = (openai_model || '').trim() || null;

    const openaiMaxOut = clampInt(toIntOrNull(openai_max_output_tokens), { min: 16, max: 8192 });

    const effortRaw = (openai_reasoning_effort || '').trim().toLowerCase();
    const openaiEffort = (effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high') ? effortRaw : null;

    const openaiApiUrl = (openai_api_url || '').trim() || null;

    const vnProvRaw = (voice_note_ai_provider || '').trim().toLowerCase();
    const voiceNoteProvider =
      (vnProvRaw === 'inherit' || vnProvRaw === 'venice' || vnProvRaw === 'openai' || vnProvRaw === 'grok') ? vnProvRaw : null;

    const voiceNoteOpenAiModel = (voice_note_openai_model || '').trim() || null;
    const voiceNoteVeniceModel = (voice_note_venice_model || '').trim() || null;

    const sttEnabled = toBoolOrNull(openai_transcribe_enabled);

    const sttModel =
      (openai_transcribe_model !== undefined && openai_transcribe_model !== null)
        ? String(openai_transcribe_model).trim()
        : null;

    const sttLang =
      (openai_transcribe_language !== undefined && openai_transcribe_language !== null)
        ? String(openai_transcribe_language).trim()
        : null;

    const sttPrompt =
      (openai_transcribe_prompt !== undefined && openai_transcribe_prompt !== null)
        ? String(openai_transcribe_prompt).trim()
        : null;

    const sttTimeout = clampInt(toIntOrNull(openai_transcribe_timeout_ms), { min: 1000, max: 300000 });

    const grokApiKey = (grok_api_key || '').trim() || null;
    const grokModel = (grok_model || '').trim() || null;
    const grokApiUrl = (grok_api_url || '').trim() || null;

    const grokTemp = clampFloat(toFloatOrNull(grok_temperature), { min: 0, max: 2 });
    const grokMaxTokens = clampInt(toIntOrNull(grok_max_tokens), { min: 16, max: 4096 });

    const voiceNoteGrokModel = (voice_note_grok_model || '').trim() || null;

    let autoAudioEnabled = toBoolOrNull(auto_audio_enabled);
    if (Array.isArray(payload.auto_audio_enabled)) {
      autoAudioEnabled = toBoolOrNull(payload.auto_audio_enabled[payload.auto_audio_enabled.length - 1]);
    }

    const autoAudioAfterMsgs = clampInt(toIntOrNull(auto_audio_after_msgs), { min: 15, max: 1000 });

    const utmifyApiToken = (utmify_api_token || '').trim() || null;

    await client.query(
      `
      UPDATE bot_settings
         SET graph_api_access_token = COALESCE($1, graph_api_access_token),
             contact_token         = COALESCE($2, contact_token),
             venice_api_key        = COALESCE($3, venice_api_key),
             venice_model          = COALESCE($4, venice_model),
             system_prompt         = COALESCE($5, system_prompt),

             inbound_debounce_min_ms = COALESCE($6, inbound_debounce_min_ms),
             inbound_debounce_max_ms = COALESCE($7, inbound_debounce_max_ms),
             inbound_max_wait_ms     = COALESCE($8, inbound_max_wait_ms),

             ai_debug = COALESCE($9, ai_debug),

             lead_max_msgs = COALESCE($10, lead_max_msgs),
             lead_ttl_ms = COALESCE($11, lead_ttl_ms),
             lead_debug_debounce = COALESCE($12, lead_debug_debounce),
             lead_late_join_window_ms = COALESCE($13, lead_late_join_window_ms),
             lead_preview_text_max_len = COALESCE($14, lead_preview_text_max_len),

             venice_api_url = COALESCE($15, venice_api_url),
             venice_temperature = COALESCE($16, venice_temperature),
             venice_max_tokens = COALESCE($17, venice_max_tokens),
             venice_timeout_ms = COALESCE($18, venice_timeout_ms),
             venice_stream = COALESCE($19, venice_stream),
             venice_user_message = COALESCE($20, venice_user_message),

             venice_enable_web_search = COALESCE($21, venice_enable_web_search),
             venice_include_venice_system_prompt = COALESCE($22, venice_include_venice_system_prompt),
             venice_enable_web_citations = COALESCE($23, venice_enable_web_citations),
             venice_enable_web_scraping = COALESCE($24, venice_enable_web_scraping),

             ai_max_out_messages = COALESCE($25, ai_max_out_messages),
             ai_error_msg_config = COALESCE($26, ai_error_msg_config),
             ai_error_msg_generic = COALESCE($27, ai_error_msg_generic),
             ai_error_msg_parse = COALESCE($28, ai_error_msg_parse),

             ai_in_delay_base_min_ms = COALESCE($29, ai_in_delay_base_min_ms),
             ai_in_delay_base_max_ms = COALESCE($30, ai_in_delay_base_max_ms),
             ai_in_delay_per_char_min_ms = COALESCE($31, ai_in_delay_per_char_min_ms),
             ai_in_delay_per_char_max_ms = COALESCE($32, ai_in_delay_per_char_max_ms),
             ai_in_delay_cap_ms = COALESCE($33, ai_in_delay_cap_ms),
             ai_in_delay_jitter_min_ms = COALESCE($34, ai_in_delay_jitter_min_ms),
             ai_in_delay_jitter_max_ms = COALESCE($35, ai_in_delay_jitter_max_ms),
             ai_in_delay_total_min_ms = COALESCE($36, ai_in_delay_total_min_ms),
             ai_in_delay_total_max_ms = COALESCE($37, ai_in_delay_total_max_ms),

             ai_out_delay_base_min_ms = COALESCE($38, ai_out_delay_base_min_ms),
             ai_out_delay_base_max_ms = COALESCE($39, ai_out_delay_base_max_ms),
             ai_out_delay_per_char_min_ms = COALESCE($40, ai_out_delay_per_char_min_ms),
             ai_out_delay_per_char_max_ms = COALESCE($41, ai_out_delay_per_char_max_ms),
             ai_out_delay_cap_ms = COALESCE($42, ai_out_delay_cap_ms),
             ai_out_delay_jitter_min_ms = COALESCE($43, ai_out_delay_jitter_min_ms),
             ai_out_delay_jitter_max_ms = COALESCE($44, ai_out_delay_jitter_max_ms),
             ai_out_delay_total_min_ms = COALESCE($45, ai_out_delay_total_min_ms),
             ai_out_delay_total_max_ms = COALESCE($46, ai_out_delay_total_max_ms),

             elevenlabs_api_key = COALESCE($47, elevenlabs_api_key),
             eleven_voice_id = COALESCE($48, eleven_voice_id),
             eleven_model_id = COALESCE($49, eleven_model_id),
             eleven_output_format = COALESCE($50, eleven_output_format),

             eleven_stability = COALESCE($51, eleven_stability),
             eleven_similarity_boost = COALESCE($52, eleven_similarity_boost),
             eleven_style = COALESCE($53, eleven_style),
             eleven_use_speaker_boost = COALESCE($54, eleven_use_speaker_boost),

            voice_note_system_prompt = COALESCE($55, voice_note_system_prompt),
            voice_note_user_prompt = COALESCE($56, voice_note_user_prompt),
            voice_note_temperature = COALESCE($57, voice_note_temperature),
            voice_note_max_tokens = COALESCE($58, voice_note_max_tokens),
            voice_note_timeout_ms = COALESCE($59, voice_note_timeout_ms),
            voice_note_history_max_items = COALESCE($60, voice_note_history_max_items),
            voice_note_history_max_chars = COALESCE($61, voice_note_history_max_chars),
            voice_note_script_max_chars = COALESCE($62, voice_note_script_max_chars),
            voice_note_fallback_text = COALESCE($63, voice_note_fallback_text),

            veltrax_api_base_url = COALESCE($64, veltrax_api_base_url),
            veltrax_client_id = COALESCE($65, veltrax_client_id),
            veltrax_client_secret = COALESCE($66, veltrax_client_secret),
            veltrax_callback_base_url = COALESCE($67, veltrax_callback_base_url),
            veltrax_webhook_path = COALESCE($68, veltrax_webhook_path),

            ai_provider = COALESCE($69, ai_provider),

            openai_api_key = COALESCE($70, openai_api_key),
            openai_model = COALESCE($71, openai_model),
            openai_max_output_tokens = COALESCE($72, openai_max_output_tokens),
            openai_reasoning_effort = COALESCE($73, openai_reasoning_effort),

            openai_api_url = COALESCE($74, openai_api_url),

            voice_note_ai_provider = COALESCE($75, voice_note_ai_provider),
            voice_note_openai_model = COALESCE($76, voice_note_openai_model),
            voice_note_venice_model = COALESCE($77, voice_note_venice_model),

            openai_transcribe_enabled = COALESCE($78, openai_transcribe_enabled),
            openai_transcribe_model = COALESCE($79, openai_transcribe_model),
            openai_transcribe_language = COALESCE($80, openai_transcribe_language),
            openai_transcribe_prompt = COALESCE($81, openai_transcribe_prompt),
            openai_transcribe_timeout_ms = COALESCE($82, openai_transcribe_timeout_ms),

            pix_gateway_default = COALESCE($83, pix_gateway_default),
            rapdyn_api_base_url = COALESCE($84, rapdyn_api_base_url),
            rapdyn_api_key = COALESCE($85, rapdyn_api_key),
            rapdyn_api_secret = COALESCE($86, rapdyn_api_secret),
            rapdyn_create_path = COALESCE($87, rapdyn_create_path),
            rapdyn_callback_base_url = COALESCE($88, rapdyn_callback_base_url),
            rapdyn_webhook_path = COALESCE($89, rapdyn_webhook_path),

            grok_api_key = COALESCE($90, grok_api_key),
            grok_model = COALESCE($91, grok_model),
            grok_api_url = COALESCE($92, grok_api_url),
            grok_temperature = COALESCE($93, grok_temperature),
            grok_max_tokens = COALESCE($94, grok_max_tokens),
            voice_note_grok_model = COALESCE($95, voice_note_grok_model),

            zoompag_api_base_url = COALESCE($96, zoompag_api_base_url),
            zoompag_api_key = COALESCE($97, zoompag_api_key),
            zoompag_create_path = COALESCE($98, zoompag_create_path),
            zoompag_callback_base_url = COALESCE($99, zoompag_callback_base_url),
            zoompag_webhook_path = COALESCE($100, zoompag_webhook_path),

            auto_audio_enabled = COALESCE($101, auto_audio_enabled),
            auto_audio_after_msgs = COALESCE($102, auto_audio_after_msgs),

            utmify_api_token = COALESCE($103, utmify_api_token),

            updated_at = NOW()
       WHERE id = 1
      `,
      [
        (graph_api_access_token || '').trim() || null,
        (contact_token || '').trim() || null,
        (venice_api_key || '').trim() || null,
        (venice_model || '').trim() || null,
        (system_prompt || '').trim() || null,

        Number.isFinite(dMin) ? dMin : null,
        Number.isFinite(dMax) ? dMax : null,
        Number.isFinite(maxW) ? maxW : null,

        aiDebug,

        Number.isFinite(leadMaxMsgs) ? leadMaxMsgs : null,
        Number.isFinite(leadTtlMs) ? leadTtlMs : null,
        leadDebugDebounce,
        Number.isFinite(leadLateJoin) ? leadLateJoin : null,
        Number.isFinite(leadPrevMax) ? leadPrevMax : null,

        (venice_api_url || '').trim() || null,
        Number.isFinite(vTemp) ? vTemp : null,
        Number.isFinite(vMaxTokens) ? vMaxTokens : null,
        Number.isFinite(vTimeout) ? vTimeout : null,
        vStream,
        (venice_user_message || '').trim() || null,

        webSearch,
        vIncSys,
        vCitations,
        vScraping,

        Number.isFinite(maxOut) ? maxOut : null,
        (ai_error_msg_config || '').trim() || null,
        (ai_error_msg_generic || '').trim() || null,
        (ai_error_msg_parse || '').trim() || null,

        Number.isFinite(inBaseMin) ? inBaseMin : null,
        Number.isFinite(inBaseMax) ? inBaseMax : null,
        Number.isFinite(inPcMin) ? inPcMin : null,
        Number.isFinite(inPcMax) ? inPcMax : null,
        Number.isFinite(inCap) ? inCap : null,
        Number.isFinite(inJMin) ? inJMin : null,
        Number.isFinite(inJMax) ? inJMax : null,
        Number.isFinite(inTMin) ? inTMin : null,
        Number.isFinite(inTMax) ? inTMax : null,

        Number.isFinite(outBaseMin) ? outBaseMin : null,
        Number.isFinite(outBaseMax) ? outBaseMax : null,
        Number.isFinite(outPcMin) ? outPcMin : null,
        Number.isFinite(outPcMax) ? outPcMax : null,
        Number.isFinite(outCap) ? outCap : null,
        Number.isFinite(outJMin) ? outJMin : null,
        Number.isFinite(outJMax) ? outJMax : null,
        Number.isFinite(outTMin) ? outTMin : null,
        Number.isFinite(outTMax) ? outTMax : null,

        elevenApiKey,
        elevenVoiceId,
        elevenModelId,
        elevenOutputFormat,

        Number.isFinite(elevenStability) ? elevenStability : null,
        Number.isFinite(elevenSimilarity) ? elevenSimilarity : null,
        Number.isFinite(elevenStyle) ? elevenStyle : null,
        elevenSpeakerBoost,

        (voice_note_system_prompt || '').trim() || null,
        (voice_note_user_prompt || '').trim() || null,

        Number.isFinite(vnTemp) ? vnTemp : null,
        Number.isFinite(vnMaxTokens) ? vnMaxTokens : null,
        Number.isFinite(vnTimeout) ? vnTimeout : null,

        Number.isFinite(vnHistItems) ? vnHistItems : null,
        Number.isFinite(vnHistChars) ? vnHistChars : null,
        Number.isFinite(vnScriptMaxChars) ? vnScriptMaxChars : null,

        (voice_note_fallback_text || '').trim() || null,

        vtxApiBase,
        vtxClientId,
        vtxClientSecret,
        vtxCbBase,
        vtxWebhookPath,

        aiProvider,

        openaiApiKey,
        openaiModel,
        Number.isFinite(openaiMaxOut) ? openaiMaxOut : null,
        openaiEffort,
        openaiApiUrl,
        voiceNoteProvider,
        voiceNoteOpenAiModel,
        voiceNoteVeniceModel,

        sttEnabled,
        sttModel,
        sttLang,
        sttPrompt,
        Number.isFinite(sttTimeout) ? sttTimeout : null,

        pixGatewayDefault,
        rApiBase,
        rKey,
        rSecret,
        rCreatePath,
        rCbBase,
        rWebhookPath,

        grokApiKey,
        grokModel,
        grokApiUrl,
        Number.isFinite(grokTemp) ? grokTemp : null,
        Number.isFinite(grokMaxTokens) ? grokMaxTokens : null,
        voiceNoteGrokModel,

        zApiBase,
        zKey,
        zCreatePath,
        zCbBase,
        zWebhookPath,

        autoAudioEnabled,
        Number.isFinite(autoAudioAfterMsgs) ? autoAudioAfterMsgs : null,

        utmifyApiToken,

      ]
    );

    _settingsCache = null;
    _settingsCacheTs = 0;
  } finally {
    client.release();
  }
}

async function listMetaNumbers() {
  const { rows } = await pool.query(
    `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at
     FROM bot_meta_numbers
     ORDER BY id ASC`
  );
  return rows;
}

async function getMetaNumberByPhoneNumberId(phoneNumberId) {
  const { rows } = await pool.query(
    `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at
     FROM bot_meta_numbers
     WHERE phone_number_id = $1 AND active = TRUE
     LIMIT 1`,
    [phoneNumberId]
  );
  return rows[0] || null;
}

async function getDefaultMetaNumber() {
  const { rows } = await pool.query(
    `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at
     FROM bot_meta_numbers
     WHERE active = TRUE
     ORDER BY id ASC
     LIMIT 1`
  );
  return rows[0] || null;
}

async function createMetaNumber({ phone_number_id, display_phone_number, access_token, label, active = true }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_meta_numbers (phone_number_id, display_phone_number, access_token, label, active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at`,
    [phone_number_id, display_phone_number || null, access_token, label || null, !!active]
  );
  return rows[0];
}

async function updateMetaNumber(id, { phone_number_id, display_phone_number, access_token, label, active = true }) {
  const { rows } = await pool.query(
    `UPDATE bot_meta_numbers
        SET phone_number_id = $2,
            display_phone_number = $3,
            access_token = $4,
            label = $5,
            active = $6,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at`,
    [id, phone_number_id, display_phone_number || null, access_token, label || null, !!active]
  );
  return rows[0] || null;
}

async function deleteMetaNumber(id) {
  await pool.query(`DELETE FROM bot_meta_numbers WHERE id = $1`, [id]);
}

async function createVeltraxDepositRow({
  wa_id, offer_id, amount, external_id, transaction_id, status,
  payer_name, payer_email, payer_document, payer_phone,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO veltrax_deposits
      (wa_id, offer_id, amount, external_id, transaction_id, status,
       payer_name, payer_email, payer_document, payer_phone, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
    RETURNING *
    `,
    [wa_id, offer_id || null, amount, external_id, transaction_id || null, status || 'PENDING',
      payer_name || null, payer_email || null, payer_document || null, payer_phone || null]
  );
  return rows[0] || null;
}

async function updateVeltraxDepositFromWebhook(payload) {
  const transaction_id = payload?.transaction_id || payload?.transactionId || null;
  const external_id = payload?.external_id || payload?.externalId || null;
  const status = payload?.status || null;

  if (!transaction_id && !external_id) return null;

  const amount = payload?.amount != null ? Number(payload.amount) : null;
  const fee = payload?.fee != null ? Number(payload.fee) : null;

  const net_amount =
    payload?.net_amount != null ? Number(payload.net_amount)
      : (payload?.net_amout != null ? Number(payload.net_amout) : null); // docs tem typo

  const end_to_end = payload?.end_to_end || payload?.endToEnd || null;

  const { rows } = await pool.query(
    `
    UPDATE veltrax_deposits
       SET status = COALESCE($3, status),
           transaction_id = COALESCE($1, transaction_id),
           fee = COALESCE($4, fee),
           net_amount = COALESCE($5, net_amount),
           end_to_end = COALESCE($6, end_to_end),
           raw_webhook = COALESCE($7::jsonb, raw_webhook),
           updated_at = NOW()
     WHERE (transaction_id = $1 AND $1 IS NOT NULL)
        OR (external_id = $2 AND $2 IS NOT NULL)
     RETURNING *
    `,
    [
      transaction_id,
      external_id,
      status,
      Number.isFinite(fee) ? fee : null,
      Number.isFinite(net_amount) ? net_amount : null,
      end_to_end,
      payload ? JSON.stringify(payload) : null,
    ]
  );

  return rows[0] || null;
}

async function countVeltraxAttempts(wa_id, offer_id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM veltrax_deposits WHERE wa_id = $1 AND offer_id = $2`,
    [wa_id, offer_id || null]
  );
  return rows[0]?.c || 0;
}

async function getLatestPendingVeltraxDeposit(wa_id, offer_id, maxAgeMs) {
  const { rows } = await pool.query(
    `
    SELECT *
      FROM veltrax_deposits
     WHERE wa_id = $1
       AND offer_id = $2
       AND status IN ('PENDING', 'CREATED')
     ORDER BY id DESC
     LIMIT 1
    `,
    [wa_id, offer_id || null]
  );
  const row = rows[0] || null;
  if (!row) return null;

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (maxAgeMs && createdAt && (Date.now() - createdAt) > maxAgeMs) return null;
  return row;
}

async function createPixDepositRow({
  provider, wa_id, offer_id, amount, external_id, transaction_id, status,
  payer_name, payer_email, payer_document, payer_phone,
  qrcode, raw_create_response,
}) {
  const { rows } = await pool.query(
    `
    INSERT INTO pix_deposits
      (provider, wa_id, offer_id, amount, external_id, transaction_id, status,
       payer_name, payer_email, payer_document, payer_phone, qrcode, raw_create_response, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, NOW())
    RETURNING *
    `,
    [
      String(provider || '').trim(),
      wa_id,
      offer_id || null,
      amount,
      external_id,
      transaction_id || null,
      status || 'PENDING',
      payer_name || null,
      payer_email || null,
      payer_document || null,
      payer_phone || null,
      qrcode || null,
      raw_create_response ? JSON.stringify(raw_create_response) : null,
    ]
  );
  return rows[0] || null;
}

async function updatePixDepositFromWebhookNormalized({
  provider, transaction_id, external_id, status,
  fee, net_amount, end_to_end, raw_webhook,
}) {
  if (!transaction_id && !external_id) return null;

  const { rows } = await pool.query(
    `
    UPDATE pix_deposits
       SET status = COALESCE($3, status),
           transaction_id = COALESCE($1, transaction_id),
           fee = COALESCE($4, fee),
           net_amount = COALESCE($5, net_amount),
           end_to_end = COALESCE($6, end_to_end),
           raw_webhook = COALESCE($7::jsonb, raw_webhook),
           updated_at = NOW()
     WHERE provider = $8
       AND (
         (transaction_id = $1 AND $1 IS NOT NULL)
         OR (external_id = $2 AND $2 IS NOT NULL)
       )
     RETURNING *
    `,
    [
      transaction_id || null,
      external_id || null,
      status || null,
      Number.isFinite(Number(fee)) ? Number(fee) : null,
      Number.isFinite(Number(net_amount)) ? Number(net_amount) : null,
      end_to_end || null,
      raw_webhook ? JSON.stringify(raw_webhook) : null,
      String(provider || '').trim(),
    ]
  );

  return rows[0] || null;
}

async function getPixDepositByTransactionId(provider, transaction_id) {
  const { rows } = await pool.query(
    `SELECT * FROM pix_deposits WHERE provider = $1 AND transaction_id = $2 LIMIT 1`,
    [String(provider), String(transaction_id)]
  );
  return rows[0] || null;
}

async function countPixAttempts(wa_id, offer_id, provider) {
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS c
      FROM pix_deposits
     WHERE wa_id = $1
       AND offer_id = $2
       AND provider = $3
    `,
    [wa_id, offer_id || null, String(provider || '').trim()]
  );
  return rows[0]?.c || 0;
}

async function getLatestPendingPixDeposit(wa_id, offer_id, provider, maxAgeMs) {
  const { rows } = await pool.query(
    `
    SELECT *
      FROM pix_deposits
     WHERE wa_id = $1
       AND offer_id = $2
       AND provider = $3
       AND status IN ('PENDING', 'CREATED')
     ORDER BY id DESC
     LIMIT 1
    `,
    [wa_id, offer_id || null, String(provider || '').trim()]
  );

  const row = rows[0] || null;
  if (!row) return null;

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (maxAgeMs && createdAt && (Date.now() - createdAt) > maxAgeMs) return null;

  return row;
}

module.exports = {
  pool,
  initDatabase,
  getBotSettings,
  updateBotSettings,
  listMetaNumbers,
  getMetaNumberByPhoneNumberId,
  getDefaultMetaNumber,
  createMetaNumber,
  updateMetaNumber,
  deleteMetaNumber,
  createVeltraxDepositRow,
  updateVeltraxDepositFromWebhook,
  countVeltraxAttempts,
  getLatestPendingVeltraxDeposit,
  createPixDepositRow,
  updatePixDepositFromWebhookNormalized,
  getPixDepositByTransactionId,
  countPixAttempts,
  getLatestPendingPixDeposit,
};