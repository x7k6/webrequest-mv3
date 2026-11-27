document.querySelector('#read').addEventListener('click', () => {
  const output = document.querySelector('#result');
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendRequest(tab.id, { type: 'page-title' }, title => {
      output.textContent = chrome.extension.lastError ? 'Open the loopback demo page first.' : title;
    });
  });
});
