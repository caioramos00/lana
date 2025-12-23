function createStore({ pool, helpers }) {
  const {
    toIntOrNull,
    clampInt,
    normalizeKindDb,
    isValidKindDb,
    toBoolLoose,
    slugifyBase,
    normalizeOfferIdInput,
    ensureValidOfferId,
    normalizeKindPreview,
    isValidKindPreview,
    ensureValidPreviewId,
    slugifyPreviewBase,
  } = helpers;

  async function listMetaNumbers() {
    const { rows } = await pool.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at FROM bot_meta_numbers ORDER BY id ASC`
    );
    return rows;
  }

  async function getMetaNumberByPhoneNumberId(phoneNumberId) {
    const { rows } = await pool.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at FROM bot_meta_numbers WHERE phone_number_id = $1 AND active = TRUE LIMIT 1`,
      [phoneNumberId]
    );
    return rows[0] || null;
  }

  async function getDefaultMetaNumber() {
    const { rows } = await pool.query(
      `SELECT id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at FROM bot_meta_numbers WHERE active = TRUE ORDER BY id ASC LIMIT 1`
    );
    return rows[0] || null;
  }

  async function createMetaNumber({ phone_number_id, display_phone_number, access_token, label, active = true }) {
    const { rows } = await pool.query(
      `INSERT INTO bot_meta_numbers (phone_number_id, display_phone_number, access_token, label, active) VALUES ($1, $2, $3, $4, $5) RETURNING id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at`,
      [phone_number_id, display_phone_number || null, access_token, label || null, !!active]
    );
    return rows[0];
  }

  async function updateMetaNumber(id, { phone_number_id, display_phone_number, access_token, label, active = true }) {
    const { rows } = await pool.query(
      `UPDATE bot_meta_numbers SET phone_number_id = $2, display_phone_number = $3, access_token = $4, label = $5, active = $6, updated_at = NOW() WHERE id = $1 RETURNING id, phone_number_id, display_phone_number, access_token, label, active, created_at, updated_at`,
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
      `INSERT INTO veltrax_deposits (wa_id, offer_id, amount, external_id, transaction_id, status, payer_name, payer_email, payer_document, payer_phone, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW()) RETURNING *`,
      [wa_id, offer_id || null, amount, external_id, transaction_id || null, status || 'PENDING', payer_name || null, payer_email || null, payer_document || null, payer_phone || null]
    );
    return rows[0] || null;
  }

  async function updateVeltraxDepositFromWebhook(payload) {
    const transaction_id = payload?.transaction_id || payload?.transactionId || null;
    const external_id = payload?.external_id || payload?.externalId || null;
    const status = payload?.status || null;
    if (!transaction_id && !external_id) return null;

    const fee = payload?.fee != null ? Number(payload.fee) : null;
    const net_amount =
      payload?.net_amount != null ? Number(payload.net_amount)
        : (payload?.net_amout != null ? Number(payload.net_amout) : null);

    const end_to_end = payload?.end_to_end || payload?.endToEnd || null;

    const { rows } = await pool.query(
      `UPDATE veltrax_deposits SET status = COALESCE($3, status), transaction_id = COALESCE($1, transaction_id), fee = COALESCE($4, fee), net_amount = COALESCE($5, net_amount), end_to_end = COALESCE($6, end_to_end), raw_webhook = COALESCE($7::jsonb, raw_webhook), updated_at = NOW() WHERE (transaction_id = $1 AND $1 IS NOT NULL) OR (external_id = $2 AND $2 IS NOT NULL) RETURNING *`,
      [transaction_id, external_id, status, Number.isFinite(fee) ? fee : null, Number.isFinite(net_amount) ? net_amount : null, end_to_end, payload ? JSON.stringify(payload) : null]
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
      `SELECT * FROM veltrax_deposits WHERE wa_id = $1 AND offer_id = $2 AND status IN ('PENDING', 'CREATED') ORDER BY id DESC LIMIT 1`,
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
    const prov = String(provider || '').trim();
    if (!prov) throw new Error('createPixDepositRow: missing provider');

    const { rows } = await pool.query(
      `INSERT INTO pix_deposits (provider, wa_id, offer_id, amount, external_id, transaction_id, status, payer_name, payer_email, payer_document, payer_phone, qrcode, raw_create_response, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, NOW()) RETURNING *`,
      [prov, wa_id, offer_id || null, amount, external_id, transaction_id || null, status || 'PENDING', payer_name || null, payer_email || null, payer_document || null, payer_phone || null, qrcode || null, raw_create_response ? JSON.stringify(raw_create_response) : null]
    );
    return rows[0] || null;
  }

  async function updatePixDepositFromWebhookNormalized({ provider, transaction_id, external_id, status, fee, net_amount, end_to_end, raw_webhook }) {
    if (!transaction_id && !external_id) return null;
    const prov = String(provider || '').trim();
    if (!prov) return null;

    const { rows } = await pool.query(
      `UPDATE pix_deposits SET status = COALESCE($3, status), transaction_id = COALESCE($1, transaction_id), fee = COALESCE($4, fee), net_amount = COALESCE($5, net_amount), end_to_end = COALESCE($6, end_to_end), raw_webhook = COALESCE($7::jsonb, raw_webhook), updated_at = NOW() WHERE provider = $8 AND ((transaction_id = $1 AND $1 IS NOT NULL) OR (external_id = $2 AND $2 IS NOT NULL)) RETURNING *`,
      [transaction_id || null, external_id || null, status || null, Number.isFinite(Number(fee)) ? Number(fee) : null, Number.isFinite(Number(net_amount)) ? Number(net_amount) : null, end_to_end || null, raw_webhook ? JSON.stringify(raw_webhook) : null, prov]
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
      `SELECT COUNT(*)::int AS c FROM pix_deposits WHERE wa_id = $1 AND offer_id = $2 AND provider = $3`,
      [wa_id, offer_id || null, String(provider || '').trim()]
    );
    return rows[0]?.c || 0;
  }

  async function getLatestPendingPixDeposit(wa_id, offer_id, provider, maxAgeMs) {
    const { rows } = await pool.query(
      `SELECT * FROM pix_deposits WHERE wa_id = $1 AND offer_id = $2 AND provider = $3 AND status IN ('PENDING', 'CREATED') ORDER BY id DESC LIMIT 1`,
      [wa_id, offer_id || null, String(provider || '').trim()]
    );
    const row = rows[0] || null;
    if (!row) return null;
    const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
    if (maxAgeMs && createdAt && (Date.now() - createdAt) > maxAgeMs) return null;
    return row;
  }

  async function getFulfillmentOfferWithMedia(idOrOfferId) {
    const raw = String(idOrOfferId || '').trim();
    if (!raw) return null;

    let offer = null;
    if (/^\d+$/.test(raw)) {
      const { rows } = await pool.query(`SELECT * FROM fulfillment_offers WHERE id = $1 LIMIT 1`, [Number(raw)]);
      offer = rows[0] || null;
    }
    if (!offer) {
      const { rows } = await pool.query(`SELECT * FROM fulfillment_offers WHERE offer_id = $1 LIMIT 1`, [raw]);
      offer = rows[0] || null;
    }
    if (!offer) return null;

    const { rows: mediaRows } = await pool.query(
      `SELECT id, offer_id, pos AS sort_order, url, caption, active, created_at, updated_at FROM fulfillment_media WHERE offer_id = $1 AND active = TRUE ORDER BY pos ASC, id ASC`,
      [offer.offer_id]
    );

    return { offer, media: mediaRows || [] };
  }

  async function listFulfillmentOffers() {
    const { rows } = await pool.query(
      `SELECT o.id, o.offer_id, COALESCE(o.title, o.offer_id) AS title, o.kind, o.enabled, o.pre_text, o.post_text, o.delay_min_ms, o.delay_max_ms, o.delay_between_min_ms, o.delay_between_max_ms, o.created_at, o.updated_at, COUNT(m.id)::int AS media_count FROM fulfillment_offers o LEFT JOIN fulfillment_media m ON m.offer_id = o.offer_id AND m.active = TRUE GROUP BY o.id ORDER BY o.id DESC`
    );
    return rows || [];
  }

  async function tryStartFulfillmentDelivery({ provider, external_id, transaction_id, wa_id, offer_id }) {
    const prov = String(provider || '').trim();
    if (!prov) return { ok: false, reason: 'missing-provider' };
    const ext = String(external_id || '').trim();
    if (!ext) return { ok: false, reason: 'missing-external_id' };

    const { rows } = await pool.query(
      `INSERT INTO fulfillment_deliveries (provider, external_id, transaction_id, wa_id, offer_id, status, attempts, started_at, updated_at) VALUES ($1,$2,$3,$4,$5,'STARTED',1, NOW(), NOW()) ON CONFLICT (provider, external_id) DO NOTHING RETURNING *`,
      [prov, ext, (transaction_id ? String(transaction_id).trim() : null), String(wa_id || '').trim(), (offer_id ? String(offer_id).trim() : null)]
    );

    if (!rows?.[0]) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM fulfillment_deliveries WHERE provider = $1 AND external_id = $2 LIMIT 1`,
        [prov, ext]
      );
      return { ok: false, reason: 'already-exists', row: existing?.[0] || null };
    }

    return { ok: true, row: rows[0] };
  }

  async function markFulfillmentDeliverySent(provider, external_id) {
    const prov = String(provider || '').trim();
    const ext = String(external_id || '').trim();
    if (!prov || !ext) return null;

    const { rows } = await pool.query(
      `UPDATE fulfillment_deliveries SET status = 'SENT', delivered_at = NOW(), updated_at = NOW() WHERE provider = $1 AND external_id = $2 RETURNING *`,
      [prov, ext]
    );
    return rows[0] || null;
  }

  async function markFulfillmentDeliveryFailed(provider, external_id, errMsg) {
    const prov = String(provider || '').trim();
    const ext = String(external_id || '').trim();
    if (!prov || !ext) return null;

    const msg = String(errMsg || '').slice(0, 1200) || 'failed';

    const { rows } = await pool.query(
      `UPDATE fulfillment_deliveries SET status = 'FAILED', last_error = $3, updated_at = NOW() WHERE provider = $1 AND external_id = $2 RETURNING *`,
      [prov, ext, msg]
    );
    return rows[0] || null;
  }

  async function resolveOfferRef(idOrOfferId) {
    const raw = String(idOrOfferId || '').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
      const { rows } = await pool.query(`SELECT id, offer_id FROM fulfillment_offers WHERE id = $1 LIMIT 1`, [Number(raw)]);
      return rows[0] || null;
    }

    const { rows } = await pool.query(`SELECT id, offer_id FROM fulfillment_offers WHERE offer_id = $1 LIMIT 1`, [raw]);
    return rows[0] || null;
  }

  async function createFulfillmentOffer(payload) {
    const title = String(payload?.title || '').trim();
    if (!title) throw new Error('Título é obrigatório');

    const kind = normalizeKindDb(payload?.kind);
    if (!isValidKindDb(kind)) throw new Error('Kind inválido (use foto|video)');

    let enabled = toBoolLoose(payload?.enabled, true);

    const pre_text = String(payload?.pre_text ?? '').trim() || null;
    const post_text = String(payload?.post_text ?? '').trim() || null;

    let delayMin = clampInt(toIntOrNull(payload?.delay_min_ms), { min: 0, max: 600000 }) ?? 30000;
    let delayMax = clampInt(toIntOrNull(payload?.delay_max_ms), { min: 0, max: 600000 }) ?? 45000;
    if (delayMin > delayMax) [delayMin, delayMax] = [delayMax, delayMin];

    let betweenMin = clampInt(toIntOrNull(payload?.delay_between_min_ms), { min: 0, max: 60000 }) ?? 250;
    let betweenMax = clampInt(toIntOrNull(payload?.delay_between_max_ms), { min: 0, max: 60000 }) ?? 900;
    if (betweenMin > betweenMax) [betweenMin, betweenMax] = [betweenMax, betweenMin];

    const base = slugifyBase(title);

    const userOfferId = normalizeOfferIdInput(payload?.offer_id);
    const userProvided = !!userOfferId;

    let offer_id = userOfferId ? ensureValidOfferId(userOfferId) : `${base}-${Date.now().toString(36)}`;

    for (let i = 0; i < 5; i++) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO fulfillment_offers (offer_id, title, kind, enabled, pre_text, post_text, delay_min_ms, delay_max_ms, delay_between_min_ms, delay_between_max_ms, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW()) RETURNING *`,
          [offer_id, title, kind, !!enabled, pre_text, post_text, delayMin, delayMax, betweenMin, betweenMax]
        );
        return rows[0] || null;
      } catch (e) {
        if (e?.code === '23505') {
          if (userProvided) throw new Error('offer_id já existe. Escolha outro.');
          offer_id = `${base}-${Math.random().toString(16).slice(2, 6)}`;
          continue;
        }
        throw e;
      }
    }

    throw new Error('Não foi possível criar offer_id único.');
  }

  async function updateFulfillmentOffer(idOrOfferId, payload) {
    const ref = await resolveOfferRef(idOrOfferId);
    if (!ref) throw new Error('Oferta não encontrada');

    const { rows: curRows } = await pool.query(`SELECT * FROM fulfillment_offers WHERE id = $1 LIMIT 1`, [ref.id]);
    const current = curRows[0];
    if (!current) throw new Error('Oferta não encontrada');

    const title = String(payload?.title || '').trim();
    if (!title) throw new Error('Título é obrigatório');

    const kind = normalizeKindDb(payload?.kind);
    if (!isValidKindDb(kind)) throw new Error('Kind inválido (use foto|video)');

    const enabled = toBoolLoose(payload?.enabled, true);

    const pre_text = String(payload?.pre_text ?? '').trim() || null;
    const post_text = String(payload?.post_text ?? '').trim() || null;

    let delayMin = clampInt(toIntOrNull(payload?.delay_min_ms), { min: 0, max: 600000 }) ?? 30000;
    let delayMax = clampInt(toIntOrNull(payload?.delay_max_ms), { min: 0, max: 600000 }) ?? 45000;
    if (delayMin > delayMax) [delayMin, delayMax] = [delayMax, delayMin];

    let betweenMin = clampInt(toIntOrNull(payload?.delay_between_min_ms), { min: 0, max: 60000 }) ?? 250;
    let betweenMax = clampInt(toIntOrNull(payload?.delay_between_max_ms), { min: 0, max: 60000 }) ?? 900;
    if (betweenMin > betweenMax) [betweenMin, betweenMax] = [betweenMax, betweenMin];

    let desiredOfferId = null;
    if (payload?.offer_id !== undefined) {
      const normalized = normalizeOfferIdInput(payload.offer_id);
      if (normalized) desiredOfferId = ensureValidOfferId(normalized);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const oldOfferId = String(current.offer_id || '').trim();
      let finalOfferId = oldOfferId;

      if (desiredOfferId && desiredOfferId !== oldOfferId) {
        await client.query(`UPDATE fulfillment_offers SET offer_id = $1, updated_at = NOW() WHERE id = $2`, [desiredOfferId, ref.id]);
        finalOfferId = desiredOfferId;

        await client.query(
          `UPDATE pix_deposits SET offer_id = $1, updated_at = NOW() WHERE offer_id = $2 AND status IN ('PENDING','CREATED')`,
          [finalOfferId, oldOfferId]
        );

        await client.query(
          `UPDATE veltrax_deposits SET offer_id = $1, updated_at = NOW() WHERE offer_id = $2 AND status IN ('PENDING','CREATED')`,
          [finalOfferId, oldOfferId]
        );

        await client.query(
          `UPDATE fulfillment_deliveries SET offer_id = $1, updated_at = NOW() WHERE offer_id = $2 AND status IN ('STARTED')`,
          [finalOfferId, oldOfferId]
        );
      }

      const { rows } = await client.query(
        `UPDATE fulfillment_offers SET title = $2, kind = $3, enabled = $4, pre_text = $5, post_text = $6, delay_min_ms = $7, delay_max_ms = $8, delay_between_min_ms = $9, delay_between_max_ms = $10, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [ref.id, title, kind, !!enabled, pre_text, post_text, delayMin, delayMax, betweenMin, betweenMax]
      );

      await client.query('COMMIT');
      return rows[0] || null;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e?.code === '23505') throw new Error('offer_id já existe. Escolha outro.');
      throw e;
    } finally {
      client.release();
    }
  }

  async function deleteFulfillmentOffer(idOrOfferId) {
    const ref = await resolveOfferRef(idOrOfferId);
    if (!ref) return null;
    const { rows } = await pool.query(`DELETE FROM fulfillment_offers WHERE id = $1 RETURNING *`, [ref.id]);
    return rows[0] || null;
  }

  async function createFulfillmentMedia({ offer_id, url, caption, sort_order }) {
    const ref = await resolveOfferRef(offer_id);
    if (!ref) throw new Error('Oferta não encontrada');

    const u = String(url || '').trim();
    if (!u) throw new Error('URL é obrigatória');

    const pos = clampInt(toIntOrNull(sort_order), { min: -999999, max: 999999 }) ?? 0;
    const cap = String(caption ?? '').trim() || null;

    const { rows } = await pool.query(
      `INSERT INTO fulfillment_media (offer_id, pos, url, caption, active, updated_at) VALUES ($1,$2,$3,$4, TRUE, NOW()) RETURNING id, offer_id, pos AS sort_order, url, caption, active, created_at, updated_at`,
      [ref.offer_id, pos, u, cap]
    );

    return rows[0] || null;
  }

  async function updateFulfillmentMedia(mid, { offer_id, url, caption, sort_order }) {
    const id = String(mid || '').trim();
    if (!id) throw new Error('mid inválido');

    let offerKey = null;
    if (offer_id !== undefined && offer_id !== null) {
      const ref = await resolveOfferRef(offer_id);
      if (!ref) throw new Error('Oferta não encontrada');
      offerKey = ref.offer_id;
    }

    const u = String(url || '').trim();
    if (!u) throw new Error('URL é obrigatória');

    const pos = clampInt(toIntOrNull(sort_order), { min: -999999, max: 999999 }) ?? 0;
    const cap = String(caption ?? '').trim() || null;

    const { rows } = await pool.query(
      `UPDATE fulfillment_media SET pos = $2, url = $3, caption = $4, updated_at = NOW() WHERE id = $1 AND ($5::text IS NULL OR offer_id = $5) RETURNING id, offer_id, pos AS sort_order, url, caption, active, created_at, updated_at`,
      [Number(id), pos, u, cap, offerKey]
    );

    return rows[0] || null;
  }

  async function deleteFulfillmentMedia(mid, { offer_id } = {}) {
    const id = String(mid || '').trim();
    if (!id) throw new Error('mid inválido');

    let offerKey = null;
    if (offer_id !== undefined && offer_id !== null) {
      const ref = await resolveOfferRef(offer_id);
      if (!ref) throw new Error('Oferta não encontrada');
      offerKey = ref.offer_id;
    }

    const { rows } = await pool.query(
      `UPDATE fulfillment_media SET active = FALSE, updated_at = NOW() WHERE id = $1 AND ($2::text IS NULL OR offer_id = $2) RETURNING id, offer_id, pos AS sort_order, url, caption, active, created_at, updated_at`,
      [Number(id), offerKey]
    );

    return rows[0] || null;
  }

  async function listPreviewOffers() {
    const { rows } = await pool.query(
      `SELECT p.id, p.preview_id, COALESCE(p.title, p.preview_id) AS title, p.kind, p.enabled, p.pre_text, p.post_text, p.delay_min_ms, p.delay_max_ms, p.delay_between_min_ms, p.delay_between_max_ms, p.created_at, p.updated_at, COUNT(m.id)::int AS media_count FROM preview_offers p LEFT JOIN preview_media m ON m.preview_id = p.preview_id AND m.active = TRUE GROUP BY p.id ORDER BY p.id DESC`
    );
    return rows || [];
  }

  async function getPreviewOfferWithMedia(idOrPreviewId) {
    const raw = String(idOrPreviewId || '').trim();
    if (!raw) return null;

    let offer = null;

    if (/^\d+$/.test(raw)) {
      const { rows } = await pool.query(`SELECT * FROM preview_offers WHERE id = $1 LIMIT 1`, [Number(raw)]);
      offer = rows[0] || null;
    }

    if (!offer) {
      const { rows } = await pool.query(`SELECT * FROM preview_offers WHERE preview_id = $1 LIMIT 1`, [raw]);
      offer = rows[0] || null;
    }

    if (!offer) return null;

    const { rows: mediaRows } = await pool.query(
      `SELECT id, preview_id, pos AS sort_order, url, caption, active, created_at, updated_at FROM preview_media WHERE preview_id = $1 AND active = TRUE ORDER BY pos ASC, id ASC`,
      [offer.preview_id]
    );

    return { offer, media: mediaRows || [] };
  }

  async function createPreviewOffer(payload) {
    const title = String(payload?.title || '').trim();
    if (!title) throw new Error('Título é obrigatório');

    const kind = normalizeKindPreview(payload?.kind);
    if (!isValidKindPreview(kind)) throw new Error('Kind inválido (use foto|video)');

    const enabled = payload?.enabled === false ? false : !!payload?.enabled;

    const pre_text = String(payload?.pre_text ?? '').trim() || null;
    const post_text = String(payload?.post_text ?? '').trim() || null;

    let delayMin = Number(payload?.delay_min_ms) || 30000;
    let delayMax = Number(payload?.delay_max_ms) || 45000;
    if (delayMin > delayMax) [delayMin, delayMax] = [delayMax, delayMin];

    let betweenMin = Number(payload?.delay_between_min_ms) || 250;
    let betweenMax = Number(payload?.delay_between_max_ms) || 900;
    if (betweenMin > betweenMax) [betweenMin, betweenMax] = [betweenMax, betweenMin];

    const base = slugifyPreviewBase(title);

    const userPreviewIdRaw = String(payload?.preview_id || '').trim();
    const userProvided = !!userPreviewIdRaw;
    let preview_id = userProvided ? ensureValidPreviewId(userPreviewIdRaw) : `${base}-${Date.now().toString(36)}`;

    for (let i = 0; i < 5; i++) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO preview_offers (preview_id, title, kind, enabled, pre_text, post_text, delay_min_ms, delay_max_ms, delay_between_min_ms, delay_between_max_ms, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW()) RETURNING *`,
          [preview_id, title, kind, !!enabled, pre_text, post_text, delayMin, delayMax, betweenMin, betweenMax]
        );
        return rows[0] || null;
      } catch (e) {
        if (e?.code === '23505') {
          if (userProvided) throw new Error('preview_id já existe. Escolha outro.');
          preview_id = `${base}-${Math.random().toString(16).slice(2, 6)}`;
          continue;
        }
        throw e;
      }
    }

    throw new Error('Não foi possível criar preview_id único.');
  }

  async function updatePreviewOffer(idOrPreviewId, payload) {
    const raw = String(idOrPreviewId || '').trim();
    if (!raw) throw new Error('missing id');

    let ref = null;
    if (/^\d+$/.test(raw)) {
      const { rows } = await pool.query(`SELECT id, preview_id FROM preview_offers WHERE id = $1 LIMIT 1`, [Number(raw)]);
      ref = rows[0] || null;
    } else {
      const { rows } = await pool.query(`SELECT id, preview_id FROM preview_offers WHERE preview_id = $1 LIMIT 1`, [raw]);
      ref = rows[0] || null;
    }
    if (!ref) throw new Error('Prévia não encontrada');

    const title = String(payload?.title || '').trim();
    if (!title) throw new Error('Título é obrigatório');

    const kind = normalizeKindPreview(payload?.kind);
    if (!isValidKindPreview(kind)) throw new Error('Kind inválido (use foto|video)');

    const enabled = payload?.enabled === false ? false : !!payload?.enabled;

    const pre_text = String(payload?.pre_text ?? '').trim() || null;
    const post_text = String(payload?.post_text ?? '').trim() || null;

    let delayMin = Number(payload?.delay_min_ms) || 30000;
    let delayMax = Number(payload?.delay_max_ms) || 45000;
    if (delayMin > delayMax) [delayMin, delayMax] = [delayMax, delayMin];

    let betweenMin = Number(payload?.delay_between_min_ms) || 250;
    let betweenMax = Number(payload?.delay_between_max_ms) || 900;
    if (betweenMin > betweenMax) [betweenMin, betweenMax] = [betweenMax, betweenMin];

    const { rows } = await pool.query(
      `UPDATE preview_offers SET title = $2, kind = $3, enabled = $4, pre_text = $5, post_text = $6, delay_min_ms = $7, delay_max_ms = $8, delay_between_min_ms = $9, delay_between_max_ms = $10, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [ref.id, title, kind, !!enabled, pre_text, post_text, delayMin, delayMax, betweenMin, betweenMax]
    );

    return rows[0] || null;
  }

  async function deletePreviewOffer(idOrPreviewId) {
    const raw = String(idOrPreviewId || '').trim();
    if (!raw) return;

    if (/^\d+$/.test(raw)) {
      await pool.query(`DELETE FROM preview_offers WHERE id = $1`, [Number(raw)]);
    } else {
      await pool.query(`DELETE FROM preview_offers WHERE preview_id = $1`, [raw]);
    }
  }

  async function createPreviewMedia({ preview_id, url, caption, sort_order }) {
    const { rows } = await pool.query(
      `INSERT INTO preview_media (preview_id, pos, url, caption, active, updated_at) VALUES ($1,$2,$3,$4, TRUE, NOW()) RETURNING *`,
      [String(preview_id).trim(), Number(sort_order) || 0, String(url).trim(), (caption ? String(caption).trim() : null)]
    );
    return rows[0] || null;
  }

  async function updatePreviewMedia(id, { preview_id, url, caption, sort_order }) {
    const { rows } = await pool.query(
      `UPDATE preview_media SET preview_id = $2, pos = $3, url = $4, caption = $5, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [Number(id), String(preview_id).trim(), Number(sort_order) || 0, String(url).trim(), (caption ? String(caption).trim() : null)]
    );
    return rows[0] || null;
  }

  async function deletePreviewMedia(id) {
    await pool.query(`UPDATE preview_media SET active = FALSE, updated_at = NOW() WHERE id = $1`, [Number(id)]);
  }

  return {
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
    getFulfillmentOfferWithMedia,
    listFulfillmentOffers,
    tryStartFulfillmentDelivery,
    markFulfillmentDeliverySent,
    markFulfillmentDeliveryFailed,
    createFulfillmentOffer,
    updateFulfillmentOffer,
    deleteFulfillmentOffer,
    createFulfillmentMedia,
    updateFulfillmentMedia,
    deleteFulfillmentMedia,
    listPreviewOffers,
    getPreviewOfferWithMedia,
    createPreviewOffer,
    updatePreviewOffer,
    deletePreviewOffer,
    createPreviewMedia,
    updatePreviewMedia,
    deletePreviewMedia,
  };
}

module.exports = { createStore };
