// SIN Solver New Tab — Script
(function() {
  'use strict';

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
