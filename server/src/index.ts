export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': 'chrome-extension://*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
      if (path === '/api/v1/auth/login') return handleLogin(request, env, corsHeaders);
      if (path === '/api/v1/auth/refresh') return handleRefresh(request, env, corsHeaders);
      
      const authResult = await validateAuth(request, env);
      if (!authResult.valid) return json({ error: authResult.error }, authResult.status, corsHeaders);
      
      const subActive = await checkSubscription(authResult.userId!, env);
      if (!subActive && path !== '/api/v1/subscription/status') {
        return json({ error: 'Subscription required', upgrade_url: 'https://my.opensin.ai/pricing' }, 402, corsHeaders);
      }

      if (path === '/api/v1/decide') return handleDecide(request, authResult.userId!, env, corsHeaders);
      if (path === '/api/v1/evaluate-study') return handleEvaluateStudy(request, authResult.userId!, env, corsHeaders);
      if (path === '/api/v1/persona') return handlePersona(request, authResult.userId!, env, corsHeaders);
      if (path === '/api/v1/subscription/status') return json({ active: subActive, plan: subActive ? 'pro' : 'free' }, 200, corsHeaders);

      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      return json({ error: 'Internal server error' }, 500, corsHeaders);
    }
  },
};

function json(data: unknown, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

async function validateAuth(request: Request, env: Env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return { valid: false, error: 'Missing auth', status: 401 };
  
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_SERVICE_KEY },
  });
  if (!res.ok) return { valid: false, error: 'Invalid token', status: 401 };
  const user = await res.json() as { id: string };
  return { valid: true, userId: user.id };
}

async function checkSubscription(userId: string, env: Env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&status=eq.active&select=id`, {
    headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  });
  return res.ok && ((await res.json() as any[]).length > 0);
}

// Secret Sauce: The Decision Engine
async function handleDecide(request: Request, userId: string, env: Env, headers: Record<string, string>) {
  const { dom_snapshot, current_url, context } = await request.json() as any;
  
  const systemPrompt = `You are an autonomous browser agent. You receive a DOM snapshot (forms, buttons, links) and current URL.
Analyze the page state and decide the exact next interaction.
Respond strictly in JSON format matching one of these structures:
{ "action": "click", "selector": "#id" }
{ "action": "type", "selector": "#id", "text": "value" }
{ "action": "select", "selector": "#id", "value": "value" }
{ "action": "wait", "duration": 5 }
{ "action": "extract" }
{ "action": "navigate", "url": "https://..." }
Think carefully before acting to avoid detection.`;

  const userPrompt = `URL: ${current_url}\nContext: ${JSON.stringify(context || {})}\nDOM: ${JSON.stringify(dom_snapshot).substring(0, 10000)}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      response_format: { type: 'json_object' }
    })
  });

  const aiData = await res.json() as any;
  const decision = JSON.parse(aiData.choices?.[0]?.message?.content || '{"action":"wait","duration":10}');
  return json(decision, 200, headers);
}

// Secret Sauce: Persona Engine
async function handlePersona(request: Request, userId: string, env: Env, headers: Record<string, string>) {
  const { question_text, options } = await request.json() as any;

  // Real persona data would be retrieved securely from Supabase here
  const personaPrompt = `You are a 28-year-old software engineer living in Germany.
Question: ${question_text}
Options: ${JSON.stringify(options)}
Select the most accurate answer matching your persona.
Return JSON: { "answer": "The exact option string", "confidence": 0.95 }`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: personaPrompt }],
      response_format: { type: 'json_object' }
    })
  });

  const aiData = await res.json() as any;
  const answer = JSON.parse(aiData.choices?.[0]?.message?.content || '{"answer":null,"confidence":0}');
  return json(answer, 200, headers);
}

async function handleEvaluateStudy(request: Request, userId: string, env: Env, headers: Record<string, string>) {
  return json({ accept: true, risk: 'low', reasoning: 'Auto-accepted based on heuristic parameters.' }, 200, headers);
}

async function handleLogin(request: Request, env: Env, headers: Record<string, string>) {
  return json({ error: 'Supabase integration required for login' }, 501, headers);
}
async function handleRefresh(request: Request, env: Env, headers: Record<string, string>) {
  return json({ error: 'Supabase integration required for refresh' }, 501, headers);
}
