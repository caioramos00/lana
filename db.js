// db.js
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        graph_api_access_token TEXT,
        contact_token TEXT,
        venice_api_key TEXT,
        venice_model TEXT,
        system_prompt TEXT,

        inbound_debounce_min_ms INTEGER,
        inbound_debounce_max_ms INTEGER,
        inbound_max_wait_ms INTEGER,

        -- ✅ NOVOS: index.js / logs
        ai_debug BOOLEAN,

        -- ✅ NOVOS: lead.js
        lead_max_msgs INTEGER,
        lead_ttl_ms INTEGER,
        lead_debug_debounce BOOLEAN,
        lead_late_join_window_ms INTEGER,
        lead_preview_text_max_len INTEGER,

        -- ✅ NOVOS: ai.js (Venice request + limits + textos)
        venice_api_url TEXT,
        venice_temperature DOUBLE PRECISION,
        venice_max_tokens INTEGER,
        venice_timeout_ms INTEGER,
        venice_stream BOOLEAN,
        venice_user_message TEXT,

        venice_enable_web_search TEXT,
        venice_include_venice_system_prompt BOOLEAN,
        venice_enable_web_citations BOOLEAN,
        venice_enable_web_scraping BOOLEAN,

        ai_max_out_messages INTEGER,
        ai_error_msg_config TEXT,
        ai_error_msg_generic TEXT,
        ai_error_msg_parse TEXT,

        -- ✅ NOVOS: human delays (ai.js)
        ai_in_delay_base_min_ms INTEGER,
        ai_in_delay_base_max_ms INTEGER,
        ai_in_delay_per_char_min_ms INTEGER,
        ai_in_delay_per_char_max_ms INTEGER,
        ai_in_delay_cap_ms INTEGER,
        ai_in_delay_jitter_min_ms INTEGER,
        ai_in_delay_jitter_max_ms INTEGER,
        ai_in_delay_total_min_ms INTEGER,
        ai_in_delay_total_max_ms INTEGER,

        ai_out_delay_base_min_ms INTEGER,
        ai_out_delay_base_max_ms INTEGER,
        ai_out_delay_per_char_min_ms INTEGER,
        ai_out_delay_per_char_max_ms INTEGER,
        ai_out_delay_cap_ms INTEGER,
        ai_out_delay_jitter_min_ms INTEGER,
        ai_out_delay_jitter_max_ms INTEGER,
        ai_out_delay_total_min_ms INTEGER,
        ai_out_delay_total_max_ms INTEGER,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ✅ garante colunas em bancos antigos
    const alter = async (sql) => client.query(sql).catch(() => { });
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_min_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_debounce_max_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS inbound_max_wait_ms INTEGER;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_debug BOOLEAN;`);

    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_max_msgs INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_ttl_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_debug_debounce BOOLEAN;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_late_join_window_ms INTEGER;`);
    await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS lead_preview_text_max_len INTEGER;`);

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

    const delayCols = [
      'ai_in_delay_base_min_ms', 'ai_in_delay_base_max_ms', 'ai_in_delay_per_char_min_ms', 'ai_in_delay_per_char_max_ms',
      'ai_in_delay_cap_ms', 'ai_in_delay_jitter_min_ms', 'ai_in_delay_jitter_max_ms', 'ai_in_delay_total_min_ms', 'ai_in_delay_total_max_ms',
      'ai_out_delay_base_min_ms', 'ai_out_delay_base_max_ms', 'ai_out_delay_per_char_min_ms', 'ai_out_delay_per_char_max_ms',
      'ai_out_delay_cap_ms', 'ai_out_delay_jitter_min_ms', 'ai_out_delay_jitter_max_ms', 'ai_out_delay_total_min_ms', 'ai_out_delay_total_max_ms',
    ];
    for (const c of delayCols) {
      await alter(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ${c} INTEGER;`);
    }

    await client.query(`
      ALTER TABLE bot_settings
      ADD CONSTRAINT bot_settings_singleton CHECK (id = 1) NOT VALID;
    `).catch(() => { });

    await client.query(`
      INSERT INTO bot_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // ✅ defaults (mantém comportamento atual)
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
             eleven_use_speaker_boost = COALESCE(eleven_use_speaker_boost, FALSE)
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

    console.log('[DB] Tabelas (bot_settings, bot_meta_numbers) OK.');
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

             updated_at            = NOW()
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
};
