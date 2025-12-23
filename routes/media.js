'use strict';

const { checkAuth } = require('./middlewares');

function toBool(v) {
  if (Array.isArray(v)) v = v[v.length - 1];
  return v === true || v === 'true' || v === '1' || v === 'on' || v === 1;
}

function toInt(v, def, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  const out = Number.isFinite(n) ? Math.trunc(n) : def;
  return Math.max(min, Math.min(max, out));
}

function cleanStr(v, maxLen = 5000) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isValidKind(k) {
  const v = String(k || '').trim().toLowerCase();
  return v === 'foto' || v === 'fotos' || v === 'video' || v === 'videos';
}

function normalizeKind(k) {
  const v = String(k || '').trim().toLowerCase();
  if (v === 'fotos') return 'foto';
  if (v === 'videos') return 'video';
  return v;
}

function isMediaRefOk(u) {
  const s = String(u || '').trim();
  if (!s) return false;

  if (/^https?:\/\//i.test(s)) return true;
  if (/^local:/i.test(s)) return true;

  if (s.includes('..')) return false;
  if (s.startsWith('/') || s.startsWith('\\')) return false;

  if (/^(fotos|videos)\/[a-z0-9_\-\/.]+$/i.test(s)) return true;

  return false;
}

function registerMediaRoutes(app, { db } = {}) {
  // OFFERS
  app.get('/admin/fulfillment/offers', checkAuth, async (req, res) => {
    try {
      const offers = await db.listFulfillmentOffers();
      res.render('fulfillment_offers', {
        offers: Array.isArray(offers) ? offers : [],
        ok: req.query.ok ? 1 : 0,
        err: req.query.err ? String(req.query.err) : '',
      });
    } catch (e) {
      res.status(500).send(`Erro ao carregar ofertas. ${e?.message || ''}`);
    }
  });

  app.get('/admin/fulfillment/offers/new', checkAuth, async (req, res) => {
    return res.render('fulfillment_offer_edit', {
      isNew: true,
      offer: {
        id: '',
        title: '',
        kind: 'foto',
        enabled: 1,
        pre_text: '',
        post_text: '',
        delay_min_ms: 30000,
        delay_max_ms: 45000,
        delay_between_min_ms: 250,
        delay_between_max_ms: 900,
      },
      media: [],
      ok: req.query.ok ? 1 : 0,
      err: req.query.err ? String(req.query.err) : '',
    });
  });

  app.post('/admin/fulfillment/offers/new', checkAuth, async (req, res) => {
    try {
      const title = cleanStr(req.body?.title, 140);
      const kind = normalizeKind(req.body?.kind);

      if (!title) return res.redirect('/admin/fulfillment/offers/new?err=' + encodeURIComponent('Título é obrigatório'));
      if (!isValidKind(kind)) return res.redirect('/admin/fulfillment/offers/new?err=' + encodeURIComponent('Kind inválido'));

      const payload = {
        offer_id: cleanStr(req.body?.offer_id, 80),
        title,
        kind,
        enabled: toBool(req.body?.enabled) ? 1 : 0,
        pre_text: cleanStr(req.body?.pre_text, 6000),
        post_text: cleanStr(req.body?.post_text, 6000),
        delay_min_ms: toInt(req.body?.delay_min_ms, 30000, { min: 0, max: 10 * 60 * 1000 }),
        delay_max_ms: toInt(req.body?.delay_max_ms, 45000, { min: 0, max: 10 * 60 * 1000 }),
        delay_between_min_ms: toInt(req.body?.delay_between_min_ms, 250, { min: 0, max: 60 * 1000 }),
        delay_between_max_ms: toInt(req.body?.delay_between_max_ms, 900, { min: 0, max: 60 * 1000 }),
      };

      const created = await db.createFulfillmentOffer(payload);
      const id = created?.id || created;
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect('/admin/fulfillment/offers/new?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.get('/admin/fulfillment/offers/:id/edit', checkAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const cfg = await db.getFulfillmentOfferWithMedia(id);
      if (!cfg?.offer) return res.redirect('/admin/fulfillment/offers?err=' + encodeURIComponent('Oferta não encontrada'));

      return res.render('fulfillment_offer_edit', {
        isNew: false,
        offer: cfg.offer,
        media: Array.isArray(cfg.media) ? cfg.media : [],
        ok: req.query.ok ? 1 : 0,
        err: req.query.err ? String(req.query.err) : '',
      });
    } catch (e) {
      return res.redirect('/admin/fulfillment/offers?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/offers/:id/edit', checkAuth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const title = cleanStr(req.body?.title, 140);
      const kind = normalizeKind(req.body?.kind);

      if (!title) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Título é obrigatório'));
      if (!isValidKind(kind)) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Kind inválido'));

      const payload = {
        offer_id: cleanStr(req.body?.offer_id, 80),
        title,
        kind,
        enabled: toBool(req.body?.enabled) ? 1 : 0,
        pre_text: cleanStr(req.body?.pre_text, 6000),
        post_text: cleanStr(req.body?.post_text, 6000),
        delay_min_ms: toInt(req.body?.delay_min_ms, 30000, { min: 0, max: 10 * 60 * 1000 }),
        delay_max_ms: toInt(req.body?.delay_max_ms, 45000, { min: 0, max: 10 * 60 * 1000 }),
        delay_between_min_ms: toInt(req.body?.delay_between_min_ms, 250, { min: 0, max: 60 * 1000 }),
        delay_between_max_ms: toInt(req.body?.delay_between_max_ms, 900, { min: 0, max: 60 * 1000 }),
      };

      const updated = await db.updateFulfillmentOffer(id, payload);
      const numericId = updated?.id || id;
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(numericId)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/offers/:id/delete', checkAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      await db.deleteFulfillmentOffer(id);
      return res.redirect('/admin/fulfillment/offers?ok=1');
    } catch (e) {
      return res.redirect('/admin/fulfillment/offers?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/offers/:id/media/add', checkAuth, async (req, res) => {
    const offerId = String(req.params.id || '').trim();
    try {
      const url = cleanStr(req.body?.url, 2000);
      const caption = cleanStr(req.body?.caption, 2000);
      const sort_order = toInt(req.body?.sort_order, 0, { min: -999999, max: 999999 });

      if (!url) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent('URL é obrigatória'));
      if (!isMediaRefOk(url)) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent('URL inválida (use http/https)'));

      await db.createFulfillmentMedia({ offer_id: offerId, url, caption, sort_order });
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/offers/:id/media/:mid/save', checkAuth, async (req, res) => {
    const offerId = String(req.params.id || '').trim();
    const mid = String(req.params.mid || '').trim();
    try {
      const url = cleanStr(req.body?.url, 2000);
      const caption = cleanStr(req.body?.caption, 2000);
      const sort_order = toInt(req.body?.sort_order, 0, { min: -999999, max: 999999 });

      if (!url) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent('URL é obrigatória'));
      if (!isMediaRefOk(url)) return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent('URL inválida (use http/https)'));

      await db.updateFulfillmentMedia(mid, { offer_id: offerId, url, caption, sort_order });
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/offers/:id/media/:mid/delete', checkAuth, async (req, res) => {
    const offerId = String(req.params.id || '').trim();
    const mid = String(req.params.mid || '').trim();
    try {
      await db.deleteFulfillmentMedia(mid, { offer_id: offerId });
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/offers/${encodeURIComponent(offerId)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  // PREVIEWS
  app.get('/admin/fulfillment/previews', checkAuth, async (req, res) => {
    try {
      const previews = await db.listPreviewOffers();
      res.render('fulfillment_previews', {
        previews: Array.isArray(previews) ? previews : [],
        ok: req.query.ok ? 1 : 0,
        err: req.query.err ? String(req.query.err) : '',
      });
    } catch (e) {
      res.status(500).send(`Erro ao carregar prévias. ${e?.message || ''}`);
    }
  });

  app.get('/admin/fulfillment/previews/new', checkAuth, async (req, res) => {
    return res.render('fulfillment_preview_edit', {
      isNew: true,
      preview: {
        id: '',
        preview_id: '',
        title: '',
        kind: 'foto',
        enabled: 1,
        pre_text: '',
        post_text: '',
        delay_min_ms: 30000,
        delay_max_ms: 45000,
        delay_between_min_ms: 250,
        delay_between_max_ms: 900,
      },
      media: [],
      ok: req.query.ok ? 1 : 0,
      err: req.query.err ? String(req.query.err) : '',
    });
  });

  app.post('/admin/fulfillment/previews/new', checkAuth, async (req, res) => {
    try {
      const title = cleanStr(req.body?.title, 140);
      const kind = normalizeKind(req.body?.kind);

      if (!title) return res.redirect('/admin/fulfillment/previews/new?err=' + encodeURIComponent('Título é obrigatório'));
      if (!isValidKind(kind)) return res.redirect('/admin/fulfillment/previews/new?err=' + encodeURIComponent('Kind inválido'));

      const payload = {
        preview_id: cleanStr(req.body?.preview_id, 80),
        title,
        kind,
        enabled: toBool(req.body?.enabled) ? 1 : 0,
        pre_text: cleanStr(req.body?.pre_text, 6000),
        post_text: cleanStr(req.body?.post_text, 6000),
        delay_min_ms: toInt(req.body?.delay_min_ms, 30000, { min: 0, max: 10 * 60 * 1000 }),
        delay_max_ms: toInt(req.body?.delay_max_ms, 45000, { min: 0, max: 10 * 60 * 1000 }),
        delay_between_min_ms: toInt(req.body?.delay_between_min_ms, 250, { min: 0, max: 60 * 1000 }),
        delay_between_max_ms: toInt(req.body?.delay_between_max_ms, 900, { min: 0, max: 60 * 1000 }),
      };

      const created = await db.createPreviewOffer(payload);
      const id = created?.id || created;
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect('/admin/fulfillment/previews/new?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.get('/admin/fulfillment/previews/:id/edit', checkAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const cfg = await db.getPreviewOfferWithMedia(id);
      if (!cfg?.offer) return res.redirect('/admin/fulfillment/previews?err=' + encodeURIComponent('Prévia não encontrada'));

      return res.render('fulfillment_preview_edit', {
        isNew: false,
        preview: cfg.offer,
        media: Array.isArray(cfg.media) ? cfg.media : [],
        ok: req.query.ok ? 1 : 0,
        err: req.query.err ? String(req.query.err) : '',
      });
    } catch (e) {
      return res.redirect('/admin/fulfillment/previews?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/previews/:id/edit', checkAuth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const title = cleanStr(req.body?.title, 140);
      const kind = normalizeKind(req.body?.kind);

      if (!title) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Título é obrigatório'));
      if (!isValidKind(kind)) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Kind inválido'));

      const payload = {
        title,
        kind,
        enabled: toBool(req.body?.enabled) ? 1 : 0,
        pre_text: cleanStr(req.body?.pre_text, 6000),
        post_text: cleanStr(req.body?.post_text, 6000),
        delay_min_ms: toInt(req.body?.delay_min_ms, 30000, { min: 0, max: 10 * 60 * 1000 }),
        delay_max_ms: toInt(req.body?.delay_max_ms, 45000, { min: 0, max: 10 * 60 * 1000 }),
        delay_between_min_ms: toInt(req.body?.delay_between_min_ms, 250, { min: 0, max: 60 * 1000 }),
        delay_between_max_ms: toInt(req.body?.delay_between_max_ms, 900, { min: 0, max: 60 * 1000 }),
      };

      await db.updatePreviewOffer(id, payload);
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/previews/:id/delete', checkAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      await db.deletePreviewOffer(id);
      return res.redirect('/admin/fulfillment/previews?ok=1');
    } catch (e) {
      return res.redirect('/admin/fulfillment/previews?err=' + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/previews/:id/media/add', checkAuth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const cfg = await db.getPreviewOfferWithMedia(id);
      if (!cfg?.offer) return res.redirect('/admin/fulfillment/previews?err=' + encodeURIComponent('Prévia não encontrada'));

      const url = cleanStr(req.body?.url, 2000);
      const caption = cleanStr(req.body?.caption, 2000);
      const sort_order = toInt(req.body?.sort_order, 0, { min: -999999, max: 999999 });

      if (!url) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('URL/ref é obrigatória'));
      if (!isMediaRefOk(url)) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Ref inválida (use http/https, local:..., ou fotos/... / videos/...)'));

      await db.createPreviewMedia({ preview_id: cfg.offer.preview_id, url, caption, sort_order });
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/previews/:id/media/:mid/save', checkAuth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const mid = String(req.params.mid || '').trim();
    try {
      const cfg = await db.getPreviewOfferWithMedia(id);
      if (!cfg?.offer) return res.redirect('/admin/fulfillment/previews?err=' + encodeURIComponent('Prévia não encontrada'));

      const url = cleanStr(req.body?.url, 2000);
      const caption = cleanStr(req.body?.caption, 2000);
      const sort_order = toInt(req.body?.sort_order, 0, { min: -999999, max: 999999 });

      if (!url) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('URL/ref é obrigatória'));
      if (!isMediaRefOk(url)) return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent('Ref inválida'));

      await db.updatePreviewMedia(mid, { preview_id: cfg.offer.preview_id, url, caption, sort_order });
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });

  app.post('/admin/fulfillment/previews/:id/media/:mid/delete', checkAuth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    const mid = String(req.params.mid || '').trim();
    try {
      await db.deletePreviewMedia(mid);
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?ok=1`);
    } catch (e) {
      return res.redirect(`/admin/fulfillment/previews/${encodeURIComponent(id)}/edit?err=` + encodeURIComponent(e?.message || 'err'));
    }
  });
}

module.exports = { registerMediaRoutes };
