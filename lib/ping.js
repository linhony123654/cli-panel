'use strict';

/**
 * Lightweight latency & connectivity health checker for Anthropic & OpenAI compatible endpoints
 */
async function pingEndpoint({ type = 'anthropic', baseUrl, apiKey, model }) {
  if (!baseUrl) {
    return { ok: false, error: '缺少 Base URL', status: 400, latency_ms: 0 };
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const isAnthropic = type === 'anthropic' || (!type && cleanBase.includes('anthropic'));
  const testModel = model || (isAnthropic ? 'claude-3-haiku-20240307' : 'gpt-4o-mini');

  let targetUrl = '';
  const headers = { 'content-type': 'application/json' };
  let payload = {};

  if (isAnthropic) {
    targetUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    payload = {
      model: testModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
  } else {
    // OpenAI compatible
    targetUrl = cleanBase.endsWith('/v1') ? `${cleanBase}/chat/completions` : `${cleanBase}/v1/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    payload = {
      model: testModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const start = Date.now();

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latency_ms = Date.now() - start;

    let resData = null;
    try {
      resData = await res.json();
    } catch {
      resData = null;
    }

    if (!res.ok) {
      const errMsg = (resData && (resData.error?.message || resData.error || resData.message)) || `HTTP ${res.status} ${res.statusText}`;
      return {
        ok: false,
        status: res.status,
        latency_ms,
        error: String(errMsg),
      };
    }

    return {
      ok: true,
      status: res.status,
      latency_ms,
      model: resData?.model || testModel,
    };
  } catch (err) {
    clearTimeout(timer);
    const latency_ms = Date.now() - start;
    const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted');
    return {
      ok: false,
      status: isTimeout ? 504 : 500,
      latency_ms,
      error: isTimeout ? '请求超时 (超过 8 秒未响应)' : (err.message || '网络连接失败'),
    };
  }
}

module.exports = { pingEndpoint };
