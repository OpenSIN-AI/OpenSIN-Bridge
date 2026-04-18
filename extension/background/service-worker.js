/**
 * ==============================================================================
 * OpenSIN Component: service-worker.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Secondary service worker for the OpenSIN Bridge extension.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Handles legacy API communication and badge status management.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * If this script fails, the extension icon won't update correctly.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


/**
 * OpenSIN Bridge — Service Worker (Background Script)
 * 
 * This is a THIN CLIENT. It contains ZERO business logic.
 * All decisions are made by the server at api.opensin.ai.
 * 
 * Responsibilities:
 * - Store/manage JWT tokens
 * - Forward messages between content script and server
 * - Handle auth token refresh
 * - Show badge status (active/inactive/error)
 */

const API_BASE = 'https://api.opensin.ai/api/v1';

// --- Token Management ---

async function getTokens() {
  const result = await chrome.storage.local.get(['jwt', 'refresh_token', 'user_id']);
  return result;
}

async function setTokens(jwt, refreshToken, userId) {
  await chrome.storage.local.set({ jwt, refresh_token: refreshToken, user_id: userId });
}

async function clearTokens() {
  await chrome.storage.local.remove(['jwt', 'refresh_token', 'user_id']);
}

// --- API Communication ---

async function apiCall(endpoint, body = null, method = 'POST') {
  const { jwt } = await getTokens();
  
  if (!jwt) {
    throw new Error('NOT_AUTHENTICATED');
  }

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, options);

  if (response.status === 401) {
    // Try refresh
    const refreshed = await refreshAuth();
    if (refreshed) {
      return apiCall(endpoint, body, method); // Retry once
    }
    throw new Error('AUTH_EXPIRED');
  }

  if (response.status === 402) {
    throw new Error('SUBSCRIPTION_REQUIRED');
  }

  if (response.status === 429) {
    throw new Error('RATE_LIMITED');
  }

  if (!response.ok) {
    throw new Error(`API_ERROR_${response.status}`);
  }

  return response.json();
}

async function refreshAuth() {
  const { refresh_token } = await getTokens();
  if (!refresh_token) return false;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });

    if (!response.ok) return false;

    const data = await response.json();
    await setTokens(data.jwt, data.refresh_token, data.user_id);
    return true;
  } catch {
    return false;
  }
}

// --- Badge Management ---

function setBadge(status) {
  const badges = {
    active: { text: 'ON', color: '#22c55e' },
    inactive: { text: 'OFF', color: '#6b7280' },
    error: { text: '!', color: '#ef4444' },
    paywall: { text: '$', color: '#f59e0b' },
  };

  const badge = badges[status] || badges.inactive;
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'API_CALL') {
    apiCall(message.endpoint, message.body, message.method || 'POST')
      .then(data => sendResponse({ success: true, data }))
      .catch(err => {
        if (err.message === 'SUBSCRIPTION_REQUIRED') {
          setBadge('paywall');
        } else if (err.message === 'NOT_AUTHENTICATED' || err.message === 'AUTH_EXPIRED') {
          setBadge('inactive');
        } else {
          setBadge('error');
        }
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }

  if (message.type === 'LOGIN') {
    fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: message.email, password: message.password }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.jwt) {
          setTokens(data.jwt, data.refresh_token, data.user_id);
          setBadge('active');
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: data.error || 'Login failed' });
        }
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'LOGOUT') {
    clearTokens();
    setBadge('inactive');
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CHECK_STATUS') {
    apiCall('/subscription/status', null, 'GET')
      .then(data => {
        setBadge(data.active ? 'active' : 'paywall');
        sendResponse({ success: true, data });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// --- Startup ---

chrome.runtime.onInstalled.addListener(() => {
  setBadge('inactive');
  console.log('[OpenSIN Bridge] Extension installed. Login required.');
});
