const $ = (id) => document.getElementById(id);

const views = {
  login: $('login-view'),
  active: $('active-view'),
  paywall: $('paywall-view'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name]?.classList.remove('hidden');
}

function setStatus(text, type) {
  const bar = $('status-bar');
  bar.textContent = text;
  bar.className = `status ${type}`;
}

function showError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

async function checkStatus() {
  chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, (res) => {
    if (res?.success && res.data?.active) {
      setStatus('Pro Active — Ready', 'active');
      showView('active');
    } else if (res?.error === 'SUBSCRIPTION_REQUIRED') {
      setStatus('Subscription Required', 'paywall');
      showView('paywall');
    } else if (res?.error === 'NOT_AUTHENTICATED' || res?.error === 'AUTH_EXPIRED') {
      setStatus('Please sign in', 'inactive');
      showView('login');
    } else {
      setStatus('Please sign in', 'inactive');
      showView('login');
    }
  });
}

$('login-btn').addEventListener('click', () => {
  const email = $('email').value.trim();
  const password = $('password').value;

  if (!email || !password) {
    showError('Email and password required');
    return;
  }

  $('login-btn').disabled = true;
  $('login-btn').textContent = 'Signing in...';

  chrome.runtime.sendMessage({ type: 'LOGIN', email, password }, (res) => {
    $('login-btn').disabled = false;
    $('login-btn').textContent = 'Sign In';

    if (res?.success) {
      checkStatus();
    } else {
      showError(res?.error || 'Login failed');
    }
  });
});

$('logout-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LOGOUT' });
  setStatus('Signed out', 'inactive');
  showView('login');
});

$('paywall-logout-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LOGOUT' });
  setStatus('Signed out', 'inactive');
  showView('login');
});

$('upgrade-btn')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://my.opensin.ai/pricing' });
});

$('start-btn')?.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'EXECUTE_ACTION',
        action: { action: 'extract' }
      }, (res) => {
        if (res?.success) {
          chrome.runtime.sendMessage({
            type: 'API_CALL',
            endpoint: '/decide',
            body: { dom_snapshot: res.data, current_url: tabs[0].url }
          });
        }
      });
    }
  });
});

checkStatus();
