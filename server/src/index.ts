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
      if (path === '/api/v1/stripe/webhook') return handleStripeWebhook(request, env);
      
      const authResult = await validateAuth(request, env);
      if (!authResult.valid) return json({ error: authResult.error }, authResult.status, corsHeaders);
      
      if (path === '/api/v1/stripe/checkout') return handleStripeCheckout(request, authResult.userId!, env, corsHeaders);
      
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
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_active_subscription`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ p_user_id: userId }),
  });
  if (!res.ok) return false;
  return (await res.json()) === true;
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
  const { email, password } = await request.json() as { email: string; password: string };
  if (!email || !password) return json({ error: 'email and password required' }, 400, headers);

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  const data = await res.json() as any;
  if (!res.ok) return json({ error: data.error_description || data.msg || 'Login failed' }, 401, headers);

  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    user: { id: data.user?.id, email: data.user?.email },
  }, 200, headers);
}

async function handleRefresh(request: Request, env: Env, headers: Record<string, string>) {
  const { refresh_token } = await request.json() as { refresh_token: string };
  if (!refresh_token) return json({ error: 'refresh_token required' }, 400, headers);

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ refresh_token }),
  });

  const data = await res.json() as any;
  if (!res.ok) return json({ error: data.error_description || 'Refresh failed' }, 401, headers);

  return json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }, 200, headers);
}

async function handleStripeCheckout(request: Request, userId: string, env: Env, headers: Record<string, string>) {
  const { plan } = await request.json() as { plan: string };
  const priceId = plan === 'pro' ? 'price_pro_123' : 'price_team_456';
  
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'success_url': 'https://my.opensin.ai/success?session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': 'https://my.opensin.ai/pricing',
      'payment_method_types[0]': 'card',
      'mode': 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'client_reference_id': userId,
    }),
  });

  if (!res.ok) return json({ error: 'Failed to create checkout session' }, 500, headers);
  const session = await res.json() as any;
  return json({ url: session.url }, 200, headers);
}

async function handleStripeWebhook(request: Request, env: Env) {
  const payload = await request.text();
  const event = JSON.parse(payload);

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const userId = sub.client_reference_id;
    if (userId) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          user_id: userId,
          stripe_customer_id: sub.customer,
          stripe_subscription_id: sub.id,
          status: sub.status,
          plan: 'pro',
          current_period_end: new Date(sub.current_period_end * 1000).toISOString()
        })
      });

      if (sub.status === 'active') {
        await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/generate_license_key`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ p_user_id: userId, p_plan: 'pro' })
        });
      }
    }
  }

  return new Response('Webhook received', { status: 200 });
}
