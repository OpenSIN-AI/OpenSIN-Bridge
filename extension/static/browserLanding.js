/**
 * ==============================================================================
 * OpenSIN Component: browserLanding.js
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * Source file for the OpenSIN ecosystem.
 * 
 * WHY IT EXISTS / WARUM ES EXISTIERT:
 * Essential logic for autonomous agent cooperation.
 * 
 * RULES / REGELN:
 * 1. EXTENSIVE LOGGING: Every function call must be traceable.
 * 2. NO ASSUMPTIONS: Validate all inputs and external states.
 * 3. SECURITY FIRST: Never leak credentials or session data.
 * 
 * CONSEQUENCES / KONSEQUENZEN:
 * Incorrect modification may disrupt agent communication or task execution.
 * 
 * AUTHOR: SIN-Zeus / A2A Fleet
 * ==============================================================================
 */


/**
 * ==============================================================================
 * OpenSIN Bridge - Core Component (V4.0.0+)
 * ==============================================================================
 * 
 * DESCRIPTION / BESCHREIBUNG:
 * This file is a critical component of the OpenSIN Bridge ecosystem. 
 * It enables direct, secure, and reliable communication between the Hugging Face 
 * MCP Server and the user's local Chrome browser.
 * 
 * ARCHITECTURE / WARUM SO GEBAUT:
 * - We DO NOT use Selenium, Puppeteer, or nodriver here.
 * - We DO NOT launch new Chrome instances with --no-sandbox.
 * - Instead, we use the Native Chrome Extension API (MV3) inside the user's 
 *   DEFAULT profile to ensure all cookies, sessions, and extensions remain intact.
 * 
 * RULES / REGELN FÜR DIESEN CODE:
 * 1. NO ASSUMPTIONS: Do not assume a tab or window exists. Always verify and handle missing states.
 * 2. EXTENSIVE LOGGING: Every action must be logged. Silent failures are prohibited.
 * 3. FALLBACKS: If an API fails (e.g. tabs.create without a window), fallback gracefully (e.g. create a window).
 * 
 * CONSEQUENCES / KONSEQUENZEN WENN GEÄNDERT:
 * - If you break the WebSocket connection here, the entire autonomous agent fleet goes blind.
 * - If you change security policies (CSP), the extension might get banned by Chrome.
 * 
 * AUTHOR: SIN-Zeus / A2A Team
 * ==============================================================================
 */

// SIN Solver New Tab — Script
(function() {
  'use strict';

  var manifestVersion = chrome.runtime.getManifest().version;
  var footerVersion = document.getElementById('footerVersion');
  if (footerVersion) {
    footerVersion.textContent = 'OpenSIN Bridge v' + manifestVersion;
  }

  var searchInput = document.getElementById('search');
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var val = searchInput.value.trim();
        if (!val) return;
        if (val.startsWith('http://') || val.startsWith('https://') || val.includes('.')) {
          window.location.href = val.startsWith('http') ? val : 'https://' + val;
        } else {
          window.location.href = 'https://www.google.com/search?q=' + encodeURIComponent(val);
        }
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage({ type: 'get_status' }, function(response) {
      var dot = document.getElementById('statusDot');
      var text = document.getElementById('statusText');
      if (response && response.connected) {
        dot.classList.remove('offline');
        text.textContent = 'SIN Bridge: Connected';
      } else {
        dot.classList.add('offline');
        text.textContent = 'SIN Bridge: Disconnected — load extension in chrome://extensions/';
      }
    });
  }
})();
