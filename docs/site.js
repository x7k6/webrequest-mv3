// Progressive enhancement: links and examples also work offline or without JS.
if (window.isSecureContext && navigator.clipboard) {
  for (const listing of document.querySelectorAll('.listing')) {
    const button = document.createElement('button');
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', `Copy ${listing.querySelector('.bar span').textContent}`);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(listing.querySelector('pre').textContent);
        button.textContent = 'Copied ✓';
      } catch {
        button.textContent = 'Select text to copy';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 2200);
    });
    listing.querySelector('.bar').append(button);
  }
}
