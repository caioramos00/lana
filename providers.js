const axios = require('axios');

function extractOpenAiOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const out = data?.output;
  if (Array.isArray(out)) {
    const chunks = [];
    for (const item of out) {
      const parts = item?.content;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p?.text === 'string') chunks.push(p.text);
          else if (typeof p?.content === 'string') chunks.push(p.content);
        }
      }
      if (typeof item?.text === 'string') chunks.push(item.text);
    }
    const joined = chunks.join('').trim();
    if (joined) return joined;
  }

  return '';
}

async function callVeniceChat({ apiKey, model, systemPromptRendered, userId, cfg, aiLog = () => { } }) {
  const url = cfg.venice_api_url;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPromptRendered },
      { role: 'user', content: cfg.userMessage },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    response_format: { type: 'json_object' },
    user: userId || undefined,
    venice_parameters: cfg.venice_parameters,
    stream: !!cfg.stream,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  aiLog(`[AI][RESPONSE][VENICE] http=${r.status}`);

  const content = r.data?.choices?.[0]?.message?.content ?? '';
  aiLog(`[AI][RESPONSE][VENICE][CONTENT]\n${content}`);

  aiLog(JSON.stringify({
    id: r.data?.id,
    model: r.data?.model,
    created: r.data?.created,
    usage: r.data?.usage,
    finish_reason: r.data?.choices?.[0]?.finish_reason,
  }, null, 2));

  return { status: r.status, content, data: r.data };
}

async function callOpenAiResponses({ apiKey, model, systemPromptRendered, userId, cfg, aiLog = () => { } }) {
  const url = cfg.openai_api_url || 'https://api.openai.com/v1/responses';

  const body = {
    model,
    input: [
      { role: 'system', content: systemPromptRendered },
      { role: 'user', content: cfg.userMessage },
    ],
    text: { format: { type: 'json_object' } },
    ...(Number.isFinite(cfg.openai_max_output_tokens) ? { max_output_tokens: cfg.openai_max_output_tokens } : {}),
    ...(cfg.openai_reasoning_effort ? { reasoning: { effort: cfg.openai_reasoning_effort } } : {}),
    ...(userId ? { user: userId } : {}),
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  aiLog(`[AI][RESPONSE][OPENAI] http=${r.status}`);

  const content = extractOpenAiOutputText(r.data);
  aiLog(`[AI][RESPONSE][OPENAI][CONTENT]\n${content}`);

  aiLog(JSON.stringify({
    id: r.data?.id,
    model: r.data?.model,
    created: r.data?.created,
    usage: r.data?.usage,
    status: r.data?.status,
    error: r.data?.error,
  }, null, 2));

  return { status: r.status, content, data: r.data };
}

async function callGrokChat({ apiKey, model, systemPromptRendered, userId, cfg, aiLog = () => { } }) {
  const url = cfg.grok_api_url;

  const body1 = {
    model,
    messages: [
      { role: 'system', content: systemPromptRendered },
      { role: 'user', content: cfg.userMessage },
    ],
    temperature: cfg.grok_temperature,
    max_tokens: cfg.grok_max_tokens,
    response_format: { type: 'json_object' },
    user: userId || undefined,
    stream: false,
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };

  const post = async (body) => axios.post(url, body, {
    headers,
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  let r = await post(body1);

  if (r.status >= 400) {
    const errStr = JSON.stringify(r.data || {});
    const looksLikeBadParam =
      /response_format|json_object|invalid.*parameter|unknown.*field/i.test(errStr);

    if (looksLikeBadParam) {
      const body2 = { ...body1 };
      delete body2.response_format;
      r = await post(body2);
    }
  }

  aiLog(`[AI][RESPONSE][GROK] http=${r.status}`);

  const content = r.data?.choices?.[0]?.message?.content ?? '';
  aiLog(`[AI][RESPONSE][GROK][CONTENT]\n${content}`);

  aiLog(JSON.stringify({
    id: r.data?.id,
    model: r.data?.model,
    created: r.data?.created,
    usage: r.data?.usage,
    finish_reason: r.data?.choices?.[0]?.finish_reason,
    error: r.data?.error,
  }, null, 2));

  return { status: r.status, content, data: r.data };
}

async function callVeniceText({ apiKey, model, systemPrompt, userPrompt, userId, cfg, aiLog = () => { } }) {
  const url = cfg.venice_api_url;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    user: userId || undefined,
    venice_parameters: cfg.venice_parameters,
    stream: false,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  aiLog(`[AI][VOICE_NOTE][VENICE] http=${r.status}`);

  const content = r.data?.choices?.[0]?.message?.content ?? '';
  return { status: r.status, content, data: r.data };
}

async function callOpenAiText({ apiKey, model, systemPrompt, userPrompt, userId, cfg, aiLog = () => { } }) {
  const url = cfg.openai_api_url || 'https://api.openai.com/v1/responses';

  const body = {
    model,
    input: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
    ...(Number.isFinite(cfg.temperature) ? { temperature: cfg.temperature } : {}),
    ...(Number.isFinite(cfg.max_output_tokens) ? { max_output_tokens: cfg.max_output_tokens } : {}),
    ...(userId ? { user: userId } : {}),
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  aiLog(`[AI][VOICE_NOTE][OPENAI] http=${r.status}`);

  const content = extractOpenAiOutputText(r.data);
  return { status: r.status, content, data: r.data };
}

async function callGrokText({ apiKey, model, systemPrompt, userPrompt, userId, cfg, aiLog = () => { } }) {
  const url = cfg.grok_api_url;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    user: userId || undefined,
    stream: false,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
  });

  aiLog(`[AI][VOICE_NOTE][GROK] http=${r.status}`);

  const content = r.data?.choices?.[0]?.message?.content ?? '';
  return { status: r.status, content, data: r.data };
}

module.exports = {
  extractOpenAiOutputText,
  callVeniceChat,
  callOpenAiResponses,
  callGrokChat,
  callVeniceText,
  callOpenAiText,
  callGrokText,
};
