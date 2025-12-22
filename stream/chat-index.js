'use strict';

const { bus } = require('./events-bus');

function collapseOneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  const t = collapseOneLine(s);
  if (!t) return '';
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function getDisplayNameFromLead(lead, wa_id) {
  try {
    const st = lead?.getLead?.(wa_id);
    const c = st?.first_inbound_payload?.contact || null;

    // WhatsApp Cloud costuma vir em contacts[0].profile.name
    const a = String(c?.profile?.name || '').trim();
    if (a) return a;

    // alguns payloads podem vir com name/formatted_name
    const b = String(c?.name?.formatted_name || '').trim();
    if (b) return b;

    const d = String(c?.name?.first_name || '').trim();
    if (d) return d;

    return '';
  } catch {
    return '';
  }
}

function normalizeMessagePreview(evt) {
  const kind = String(evt?.kind || '').trim();
  const t = String(evt?.text || '').trim();
  if (t) return t;
  if (!kind) return '';
  if (kind === 'audio') return '[áudio]';
  if (kind === 'image') return '[imagem]';
  if (kind === 'video') return '[vídeo]';
  if (kind === 'document') return '[documento]';
  return `[${kind}]`;
}

function createChatIndex({ lead, maxChats = 10000 } = {}) {
  const chats = new Map(); // wa_id -> summary

  function ensure(wa_id, ts) {
    const id = String(wa_id || '').trim();
    if (!id) return null;

    let c = chats.get(id);
    if (!c) {
      c = {
        wa_id: id,
        title: null,
        created_ts: Number.isFinite(ts) ? ts : Date.now(),
        last_ts: Number.isFinite(ts) ? ts : Date.now(),
        last_text: '',
        last_dir: null,
        unread: 0,
      };
      chats.set(id, c);

      // limite simples (remove o mais antigo)
      if (chats.size > Math.max(50, Number(maxChats) || 2000)) {
        const arr = Array.from(chats.values());
        arr.sort((a, b) => (a.last_ts || 0) - (b.last_ts || 0));
        const toDrop = arr.slice(0, Math.max(1, arr.length - maxChats));
        for (const x of toDrop) chats.delete(x.wa_id);
      }
    }

    // tenta preencher título
    if (!c.title) {
      const nm = getDisplayNameFromLead(lead, id);
      c.title = nm || null;
    }

    return c;
  }

  function onEvt(evt) {
    const wa_id = String(evt?.wa_id || '').trim();
    if (!wa_id) return;

    const ts = Number.isFinite(Number(evt?.ts)) ? Number(evt.ts) : Date.now();
    const c = ensure(wa_id, ts);
    if (!c) return;

    c.last_ts = Math.max(Number(c.last_ts) || 0, ts);

    if (String(evt?.type) === 'message') {
      c.last_dir = evt?.dir === 'out' ? 'out' : 'in';
      c.last_text = clip(normalizeMessagePreview(evt), 90);

      // nome pode aparecer depois do primeiro inbound (depende do fluxo)
      if (!c.title) {
        const nm = getDisplayNameFromLead(lead, wa_id);
        if (nm) c.title = nm;
      }
    }
  }

  // indexa tudo que passa no bus
  bus.on('evt', onEvt);

  return {
    list({ limit = 500 } = {}) {
      const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
      const arr = Array.from(chats.values());
      arr.sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
      return arr.slice(0, lim).map((c) => ({
        wa_id: c.wa_id,
        title: c.title || c.wa_id,
        created_ts: c.created_ts,
        last_ts: c.last_ts,
        last_text: c.last_text,
        last_dir: c.last_dir,
        unread: c.unread || 0,
      }));
    },

    ensureKnown(wa_id) {
      ensure(wa_id, Date.now());
    },
  };
}

module.exports = { createChatIndex };
