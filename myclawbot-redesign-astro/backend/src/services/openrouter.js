export async function openRouterChat({ model, messages, max_tokens = 512 }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost:4321',
      'X-Title': 'MyClawBot',
    },
    body: JSON.stringify({ model, messages, max_tokens }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter error: ${res.status} ${errText}`);
  }

  return await res.json();
}
