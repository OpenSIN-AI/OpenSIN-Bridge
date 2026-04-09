chrome.runtime.sendMessage({ type: 'get_status' }, function(response) {
  var el = document.getElementById('status');
  if (response && response.connected) {
    el.className = 'status connected';
    el.textContent = 'Connected to Native Host';
  } else {
    el.className = 'status disconnected';
    el.textContent = 'Native Host not connected';
  }
});
