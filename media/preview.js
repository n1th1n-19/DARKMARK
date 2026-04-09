// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** Run highlight.js on all code blocks in the document */
  function highlightAll() {
    document.querySelectorAll('pre.code-block code').forEach((block) => {
      hljs.highlightElement(/** @type {HTMLElement} */ (block));
    });
  }

  // Initial highlight pass
  highlightAll();

  // Inject the "Edit Source" button
  const btn = document.createElement('button');
  btn.id = 'edit-source-btn';
  btn.innerHTML = '&#9998; Edit Source';
  btn.addEventListener('click', () => {
    vscode.postMessage({ command: 'editSource' });
  });
  document.body.appendChild(btn);

  // Handle live-update messages from the extension host
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.command === 'update') {
      const container = document.getElementById('preview-content');
      if (container) {
        container.innerHTML = message.html;
        highlightAll();
      }
    }
  });
})();
