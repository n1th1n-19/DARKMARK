// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const content = /** @type {HTMLElement} */ (document.getElementById('preview-content'));

  mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });

  /** Run highlight.js on all code blocks in the document */
  function highlightAll() {
    content.querySelectorAll('pre.code-block code').forEach((block) => {
      hljs.highlightElement(/** @type {HTMLElement} */ (block));
    });
  }

  /** Add a copy-to-clipboard button to every code block */
  function addCopyButtons() {
    content.querySelectorAll('pre.code-block').forEach((pre) => {
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? '');
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      });
      pre.appendChild(btn);
    });
  }

  /** Rebuild the table of contents from h1–h3 */
  function buildToc() {
    const headings = content.querySelectorAll('h1[id], h2[id], h3[id]');
    toc.replaceChildren(
      ...Array.from(headings, (h) => {
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent;
        a.className = 'toc-' + h.tagName.toLowerCase();
        return a;
      })
    );
    tocBtn.hidden = headings.length === 0;
  }

  /** Everything that must re-run after the content is replaced */
  function enhance() {
    highlightAll();
    addCopyButtons();
    buildToc();
    // Invalid diagrams (e.g. mid-typing) render mermaid's own error box
    mermaid.run({ nodes: content.querySelectorAll('pre.mermaid') }).catch(() => {});
  }

  // Inject the "Edit Source" and "Contents" buttons
  const btn = document.createElement('button');
  btn.id = 'edit-source-btn';
  btn.innerHTML = '&#9998; Edit Source';
  btn.addEventListener('click', () => {
    vscode.postMessage({ command: 'editSource' });
  });

  const toc = document.createElement('nav');
  toc.id = 'toc';
  toc.hidden = true;

  const tocBtn = document.createElement('button');
  tocBtn.id = 'toc-btn';
  tocBtn.innerHTML = '&#9776; Contents';
  tocBtn.addEventListener('click', () => (toc.hidden = !toc.hidden));

  document.body.append(toc, tocBtn, btn);

  // The webview can't navigate: route link clicks ourselves.
  // getAttribute gives the raw href (a.href would be resolved against <base>).
  document.addEventListener('click', (event) => {
    const a = /** @type {HTMLElement} */ (event.target).closest('a[href]');
    if (!a) return;
    event.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      vscode.postMessage({ command: 'openExternal', href });
    } else {
      vscode.postMessage({ command: 'openLink', href });
    }
  });

  // Initial pass
  enhance();

  // Handle live-update messages from the extension host
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.command === 'update') {
      content.innerHTML = message.html;
      enhance();
    }
  });
})();
