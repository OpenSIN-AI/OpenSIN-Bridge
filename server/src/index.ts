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

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/api/v1/auth/login' && request.method === 'POST') {
        return handleLogin(request, env, corsHeaders);
      }

      if (path === '/api/v1/auth/refresh' && request.method === 'POST') {
        return handleRefresh(request, env, corsHeaders);
      }

      if (path === '/api/v1/stripe/webhook' && request.method === 'POST') {
        return handleStripeWebhook(request, env);
      }

      const authResult = await validateAuth(request, env);
      if (!authResult.valid) {
        return json({ error: authResult.error }, authResult.status, corsHeaders);
      }

      if (path === '/api/v1/subscription/status' && request.method === 'GET') {
        return handleSubscriptionStatus(authResult.userId, env, corsHeaders);
      }

      const subActive = await checkSubscription(authResult.userId, env);
      if (!subActive) {
        return json({ error: 'Subscription required', upgrade_url: 'https://my.opensin.ai/pricing' }, 402, corsHeaders);
      }

      if (path === '/api/v1/decide' && request.method === 'POST') {
        return handleDecide(request, authResult.userId, env, corsHeaders);
      }

      if (path === '/api/v1/evaluate-study' && request.method === 'POST') {
        return handleEvaluateStudy(request, authResult.userId, env, corsHeaders);
      }

      if (path === '/api/v1/persona' && request.method === 'POST') {
        return handlePersona(request, authResult.userId, env, corsHeaders);
      }

      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error' }, 500, corsHeaders);
    }
  },
};

function json(data: unknown, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// ============================================================
// AUTH — validates JWT, returns userId
// ============================================================

async function validateAuth(request: Request, env: Env): Promise<{ valid: boolean; userId?: string; error?: string; status?: number }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing authorization', status: 401 };
  }

  const token = authHeader.slice(7);

  const verifyUrl = `${env.SUPABASE_URL}/auth/v1/user`;
  const res = await fetch(verifyUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': env.SUPABASE_SERVICE_KEY,
    },
  });

  if (!res.ok) {
    return { valid: false, error: 'Invalid or expired token', status: 401 };
  }

  const user = await res.json() as { id: string };
  return { valid: true, userId: user.id };
}

// ============================================================
// SUBSCRIPTION CHECK — queries Supabase for active plan
// ============================================================

async function checkSubscription(userId: string, env: Env): Promise<boolean> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&status=eq.active&select=id`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) return false;
  const rows = await res.json() as unknown[];
  return rows.length > 0;
}

// ============================================================
// ROUTE HANDLERS — stubs for now, will contain SECRET SAUCE
// ============================================================

async function handleLogin(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json() as { email: string; password: string };

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    return json({ error: (data as { error_description?: string }).error_description || 'Login failed' }, 401, headers);
  }

  return json({
    jwt: data.access_token,
    refresh_token: data.refresh_token,
    user_id: (data.user as { id: string })?.id,
  }, 200, headers);
}

async function handleRefresh(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json() as { refresh_token: string };

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    return json({ error: 'Refresh failed' }, 401, headers);
  }

  return json({
    jwt: data.access_token,
    refresh_token: data.refresh_token,
    user_id: (data.user as { id: string })?.id,
  }, 200, headers);
}

async function handleSubscriptionStatus(userId: string, env: Env, headers: Record<string, string>): Promise<Response> {
  const active = await checkSubscription(userId, env);
  return json({ active, plan: active ? 'pro' : 'free' }, 200, headers);
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  // TODO: Verify Stripe signature, update Supabase subscription status
  return json({ received: true });
}

async function handleDecide(request: Request, userId: string, env: Env, headers: Record<string, string>): Promise<Response> {
  // SECRET SAUCE — LLM decision engine
  // This function contains proprietary logic that NEVER leaves this server
  const body = await request.json() as { dom_snapshot: unknown; current_url: string };

  await logUsage(userId, 'decide', env);

  // TODO: Implement full LLM decision pipeline
  return json({
    action: 'wait',
    duration: 5,
    reasoning: 'Server decision engine — implementation pending',
  }, 200, headers);
}

async function handleEvaluateStudy(request: Request, userId: string, env: Env, headers: Record<string, string>): Promise<Response> {
  // SECRET SAUCE — Study risk evaluation
  const body = await request.json() as { study_title: string; reward: number; duration: number };

  await logUsage(userId, 'evaluate_study', env);

  // TODO: Implement study evaluation logic
  return json({
    accept: false,
    reasoning: 'Study evaluation engine — implementation pending',
    risk: 'unknown',
  }, 200, headers);
}

async function handlePersona(request: Request, userId: string, env: Env, headers: Record<string, string>): Promise<Response> {
  // SECRET SAUCE — Persona answer generation
  const body = await request.json() as { question_text: string; question_type: string };

  await logUsage(userId, 'persona', env);

  // TODO: Implement persona engine
  return json({
    answer: null,
    confidence: 0,
    reasoning: 'Persona engine — implementation pending',
  }, 200, headers);
}

async function logUsage(userId: string, action: string, env: Env): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ user_id: userId, action }),
    });
  } catch {
    // Non-critical — don't fail the request
  }
}
