'use strict';

function createSettings({ pool, helpers, cache }) {
  const {
    strOrNull,
    toIntOrNull,
    toFloatOrNull,
    toBoolOrNull,
    clampInt,
    clampFloat,
  } = helpers;

  async function getBotSettings({ bypassCache = false } = {}) {
    const now = Date.now();
    if (!bypassCache && cache.value && now - cache.ts < cache.ttlMs) return cache.value;

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
        meta_ads_access_token,
        meta_ads_ad_account_id,
        meta_ads_api_version,
        meta_ads_timeout_ms,
        meta_ads_cache_ttl_ms,
        updated_at
      FROM bot_settings
      WHERE id = 1
      LIMIT 1
    `);

    cache.value = rows[0] || { id: 1 };
    cache.ts = now;
    return cache.value;
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
        meta_ads_access_token,
        meta_ads_ad_account_id,
        meta_ads_api_version,
        meta_ads_timeout_ms,
        meta_ads_cache_ttl_ms,
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

      const webSearch = strOrNull(venice_enable_web_search);
      const vIncSys = toBoolOrNull(venice_include_venice_system_prompt);
      const vCitations = toBoolOrNull(venice_enable_web_citations);
      const vScraping = toBoolOrNull(venice_enable_web_scraping);

      const maxOut = clampInt(toIntOrNull(ai_max_out_messages), { min: 1, max: 10 });

      function cDelay(v, min, max) {
        return clampInt(toIntOrNull(v), { min, max });
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

      const elevenApiKey = strOrNull(elevenlabs_api_key);
      const elevenVoiceId = strOrNull(eleven_voice_id);
      const elevenModelId = strOrNull(eleven_model_id);
      const elevenOutputFormat = strOrNull(eleven_output_format);

      const elevenStability = clampFloat(toFloatOrNull(eleven_stability), { min: 0, max: 1 });
      const elevenSimilarity = clampFloat(toFloatOrNull(eleven_similarity_boost), { min: 0, max: 1 });
      const elevenStyle = clampFloat(toFloatOrNull(eleven_style), { min: 0, max: 1 });
      const elevenSpeakerBoost = toBoolOrNull(eleven_use_speaker_boost);

      const vnTemp = clampFloat(toFloatOrNull(voice_note_temperature), { min: 0, max: 2 });
      const vnMaxTokens = clampInt(toIntOrNull(voice_note_max_tokens), { min: 16, max: 4096 });
      const vnTimeout = clampInt(toIntOrNull(voice_note_timeout_ms), { min: 1000, max: 180000 });

      const vnHistItems = clampInt(toIntOrNull(voice_note_history_max_items), { min: 1, max: 50 });
      const vnHistChars = clampInt(toIntOrNull(voice_note_history_max_chars), { min: 200, max: 8000 });
      const vnScriptMaxChars = clampInt(toIntOrNull(voice_note_script_max_chars), { min: 200, max: 4000 });

      const pixGatewayDefaultRaw = String(pix_gateway_default || '').trim().toLowerCase();
      const pixGatewayDefault =
        (pixGatewayDefaultRaw === 'veltrax' || pixGatewayDefaultRaw === 'rapdyn' || pixGatewayDefaultRaw === 'zoompag')
          ? pixGatewayDefaultRaw
          : null;

      const rApiBase = strOrNull(rapdyn_api_base_url);
      const rKey = strOrNull(rapdyn_api_key);
      const rSecret = strOrNull(rapdyn_api_secret);
      const rCreatePath = strOrNull(rapdyn_create_path);
      const rCbBase = strOrNull(rapdyn_callback_base_url);
      const rWebhookPath = strOrNull(rapdyn_webhook_path);

      const vtxApiBase = strOrNull(veltrax_api_base_url);
      const vtxClientId = strOrNull(veltrax_client_id);
      const vtxClientSecret = strOrNull(veltrax_client_secret);
      const vtxCbBase = strOrNull(veltrax_callback_base_url);
      const vtxWebhookPath = strOrNull(veltrax_webhook_path);

      const zApiBase = strOrNull(zoompag_api_base_url);
      const zKey = strOrNull(zoompag_api_key);
      const zCreatePath = strOrNull(zoompag_create_path);
      const zCbBase = strOrNull(zoompag_callback_base_url);
      const zWebhookPath = strOrNull(zoompag_webhook_path);

      const aiProviderRaw = String(ai_provider || '').trim().toLowerCase();
      const aiProvider = (aiProviderRaw === 'venice' || aiProviderRaw === 'openai' || aiProviderRaw === 'grok') ? aiProviderRaw : null;

      const openaiApiKey = strOrNull(openai_api_key);
      const openaiModel = strOrNull(openai_model);
      const openaiMaxOut = clampInt(toIntOrNull(openai_max_output_tokens), { min: 16, max: 8192 });
      const effortRaw = String(openai_reasoning_effort || '').trim().toLowerCase();
      const openaiEffort = (effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high') ? effortRaw : null;
      const openaiApiUrl = strOrNull(openai_api_url);

      const vnProvRaw = String(voice_note_ai_provider || '').trim().toLowerCase();
      const voiceNoteProvider =
        (vnProvRaw === 'inherit' || vnProvRaw === 'venice' || vnProvRaw === 'openai' || vnProvRaw === 'grok')
          ? vnProvRaw
          : null;

      const voiceNoteOpenAiModel = strOrNull(voice_note_openai_model);
      const voiceNoteVeniceModel = strOrNull(voice_note_venice_model);

      const sttEnabled = toBoolOrNull(openai_transcribe_enabled);
      const sttModel = (openai_transcribe_model !== undefined && openai_transcribe_model !== null) ? String(openai_transcribe_model).trim() : null;
      const sttLang = (openai_transcribe_language !== undefined && openai_transcribe_language !== null) ? String(openai_transcribe_language).trim() : null;
      const sttPrompt = (openai_transcribe_prompt !== undefined && openai_transcribe_prompt !== null) ? String(openai_transcribe_prompt).trim() : null;
      const sttTimeout = clampInt(toIntOrNull(openai_transcribe_timeout_ms), { min: 1000, max: 300000 });

      const grokApiKey = strOrNull(grok_api_key);
      const grokModel = strOrNull(grok_model);
      const grokApiUrl = strOrNull(grok_api_url);
      const grokTemp = clampFloat(toFloatOrNull(grok_temperature), { min: 0, max: 2 });
      const grokMaxTokens = clampInt(toIntOrNull(grok_max_tokens), { min: 16, max: 4096 });
      const voiceNoteGrokModel = strOrNull(voice_note_grok_model);

      let autoAudioEnabled = toBoolOrNull(auto_audio_enabled);
      if (Array.isArray(payload.auto_audio_enabled)) {
        autoAudioEnabled = toBoolOrNull(payload.auto_audio_enabled[payload.auto_audio_enabled.length - 1]);
      }

      const autoAudioAfterMsgs = clampInt(toIntOrNull(auto_audio_after_msgs), { min: 1, max: 1000 });

      const utmifyApiToken = strOrNull(utmify_api_token);

      const metaAdsToken = strOrNull(meta_ads_access_token);
      const metaAdsAccount = strOrNull(meta_ads_ad_account_id);
      const metaAdsVersion = strOrNull(meta_ads_api_version);
      const metaAdsTimeout = clampInt(toIntOrNull(meta_ads_timeout_ms), { min: 1000, max: 120000 });
      const metaAdsCacheTtl = clampInt(toIntOrNull(meta_ads_cache_ttl_ms), { min: 0, max: 604800000 });

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
               meta_ads_access_token = COALESCE($104, meta_ads_access_token),
               meta_ads_ad_account_id = COALESCE($105, meta_ads_ad_account_id),
               meta_ads_api_version = COALESCE($106, meta_ads_api_version),
               meta_ads_timeout_ms = COALESCE($107, meta_ads_timeout_ms),
               meta_ads_cache_ttl_ms = COALESCE($108, meta_ads_cache_ttl_ms),
               updated_at = NOW()
         WHERE id = 1
        `,
        [
          strOrNull(graph_api_access_token),
          strOrNull(contact_token),
          strOrNull(venice_api_key),
          strOrNull(venice_model),
          strOrNull(system_prompt),
          Number.isFinite(dMin) ? dMin : null,
          Number.isFinite(dMax) ? dMax : null,
          Number.isFinite(maxW) ? maxW : null,
          aiDebug,
          Number.isFinite(leadMaxMsgs) ? leadMaxMsgs : null,
          Number.isFinite(leadTtlMs) ? leadTtlMs : null,
          leadDebugDebounce,
          Number.isFinite(leadLateJoin) ? leadLateJoin : null,
          Number.isFinite(leadPrevMax) ? leadPrevMax : null,
          strOrNull(venice_api_url),
          Number.isFinite(vTemp) ? vTemp : null,
          Number.isFinite(vMaxTokens) ? vMaxTokens : null,
          Number.isFinite(vTimeout) ? vTimeout : null,
          vStream,
          strOrNull(venice_user_message),
          webSearch,
          vIncSys,
          vCitations,
          vScraping,
          Number.isFinite(maxOut) ? maxOut : null,
          strOrNull(ai_error_msg_config),
          strOrNull(ai_error_msg_generic),
          strOrNull(ai_error_msg_parse),
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
          strOrNull(voice_note_system_prompt),
          strOrNull(voice_note_user_prompt),
          Number.isFinite(vnTemp) ? vnTemp : null,
          Number.isFinite(vnMaxTokens) ? vnMaxTokens : null,
          Number.isFinite(vnTimeout) ? vnTimeout : null,
          Number.isFinite(vnHistItems) ? vnHistItems : null,
          Number.isFinite(vnHistChars) ? vnHistChars : null,
          Number.isFinite(vnScriptMaxChars) ? vnScriptMaxChars : null,
          strOrNull(voice_note_fallback_text),
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
          metaAdsToken,
          metaAdsAccount,
          metaAdsVersion,
          Number.isFinite(metaAdsTimeout) ? metaAdsTimeout : null,
          Number.isFinite(metaAdsCacheTtl) ? metaAdsCacheTtl : null,
        ]
      );

      cache.value = null;
      cache.ts = 0;
    } finally {
      client.release();
    }
  }

  return { getBotSettings, updateBotSettings };
}

module.exports = { createSettings };
