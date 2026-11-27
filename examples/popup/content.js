chrome.extension.onRequest.addListener((message, sender, respond) => {
  if (message.type === 'page-title') respond(document.title);
});
