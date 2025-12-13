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

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        graph_api_access_token TEXT,
        contact_token TEXT, -- aqui é o verify_token do webhook
        venice_api_key TEXT,
        venice_model TEXT,
        system_prompt TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // singleton (id=1)
    await client.query(`
      ALTER TABLE bot_settings
      ADD CONSTRAINT bot_settings_singleton CHECK (id = 1) NOT VALID;
    `).catch(() => {});

    await client.query(`
      INSERT INTO bot_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
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
    } = payload;

    await client.query(
      `
      UPDATE bot_settings
         SET graph_api_access_token = COALESCE($1, graph_api_access_token),
             contact_token         = COALESCE($2, contact_token),
             venice_api_key        = COALESCE($3, venice_api_key),
             venice_model          = COALESCE($4, venice_model),
             system_prompt         = COALESCE($5, system_prompt),
             updated_at            = NOW()
       WHERE id = 1
      `,
      [
        (graph_api_access_token || '').trim() || null,
        (contact_token || '').trim() || null,
        (venice_api_key || '').trim() || null,
        (venice_model || '').trim() || null,
        (system_prompt || '').trim() || null,
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
