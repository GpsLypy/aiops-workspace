(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('site-data').textContent);
  const chapters = [...document.querySelectorAll('[data-chapter]')];
  const home = document.getElementById('home');
  const outline = document.getElementById('outline-links');
  const sidebar = document.getElementById('sidebar');
  const menu = document.getElementById('menu-toggle');
  const dialog = document.getElementById('search-dialog');
  const diagramDialog = document.getElementById('diagram-dialog');
  const input = document.getElementById('search-input');
  let current = 'overview';
  let step = 0;
  const safeHash = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
  function closeMenu() { sidebar.classList.remove('is-open'); menu.setAttribute('aria-expanded', 'false'); }
  function progress() {
    const range = document.documentElement.scrollHeight - innerHeight;
    document.getElementById('reading-progress').style.width = `${range > 0 ? Math.min(100, scrollY / range * 100) : 0}%`;
  }
  function navigate(initial = false) {
    const hash = safeHash();
    const target = document.getElementById(hash);
    const selected = target?.closest('[data-chapter]');
    current = selected?.dataset.chapter || 'overview';
    for (const chapter of chapters) chapter.hidden = chapter.dataset.chapter !== current;
    home.hidden = current !== 'overview';
    for (const link of document.querySelectorAll('.nav-link')) {
      if (link.hash === `#${current}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const meta = data.chapters.find(c => c.id === current);
    document.title = `${meta.title} · 运维百晓生`;
    document.getElementById('current-chapter').textContent = meta.title;
    const article = chapters.find(c => c.dataset.chapter === current);
    outline.replaceChildren();
    for (const heading of article.querySelectorAll('h2')) {
      const link = document.createElement('a'); link.href = `#${heading.id}`; link.textContent = heading.textContent;
      outline.append(link);
    }
    closeMenu();
    if (!initial || hash) requestAnimationFrame(() => {
      const destination = target && selected ? target : document.getElementById('main');
      if (hash === 'overview' || !selected) window.scrollTo({ top: 0, behavior: 'instant' });
      else destination.scrollIntoView({ block: 'start', behavior: 'instant' });
      const focus = destination.matches('h1,h2,h3') ? destination : destination.querySelector('h1');
      if (focus) { focus.setAttribute('tabindex', '-1'); focus.focus({ preventScroll: true }); }
      progress();
    });
    progress();
  }
  document.documentElement.classList.add('enhanced');
  document.getElementById('search-open').setAttribute('aria-label', '搜索完整手册');
  window.addEventListener('hashchange', () => navigate());
  window.addEventListener('scroll', progress, { passive: true });
  window.addEventListener('resize', progress);
  menu.addEventListener('click', () => { const open = sidebar.classList.toggle('is-open'); menu.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', event => {
    if (sidebar.classList.contains('is-open') && !sidebar.contains(event.target) && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeMenu();
      if (dialog.open) { event.preventDefault(); dialog.close(); }
      if (diagramDialog.open) { event.preventDefault(); diagramDialog.close(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  });
  const themeButton = document.getElementById('theme-toggle');
  function theme(value) {
    document.documentElement.dataset.theme = value;
    themeButton.setAttribute('aria-label', value === 'dark' ? '切换浅色主题' : '切换深色主题');
    themeButton.textContent = value === 'dark' ? '☀' : '◐';
    try { localStorage.setItem('aiops-docs-theme', value); } catch { /* file:// or blocked storage remains usable */ }
  }
  let savedTheme;
  try { savedTheme = localStorage.getItem('aiops-docs-theme'); } catch { /* optional preference */ }
  theme(savedTheme === 'dark' ? 'dark' : 'light');
  themeButton.addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  const searchIndex = [];
  for (const chapter of chapters) {
    const meta = data.chapters.find(c => c.id === chapter.dataset.chapter);
    let entry;
    for (const element of chapter.querySelector('.prose').children) {
      if (element.matches('h1,h2,h3')) {
        entry = { title: element.textContent, chapter: meta.title, id: element.id || chapter.id, text: '' };
        searchIndex.push(entry);
      } else if (entry) entry.text += ` ${element.textContent.replace(/\s+/g, ' ')}`;
    }
  }
  function openSearch() { if (!dialog.open) dialog.showModal(); input.focus(); input.select(); search(); }
  document.getElementById('search-open').addEventListener('click', openSearch);
  document.getElementById('search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  input.addEventListener('input', search);
  function search() {
    const query = input.value.trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const results = document.getElementById('search-results'); results.replaceChildren();
    if (!query) { document.getElementById('search-status').textContent = '搜索整本手册，例如：工具调用、30 条、备份、Cron。'; return; }
    const matches = searchIndex.filter(e => tokens.every(t => `${e.title} ${e.text}`.toLowerCase().includes(t)))
      .sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)));
    document.getElementById('search-status').textContent = matches.length ? `找到 ${matches.length} 个相关小节${matches.length > 30 ? '，显示前 30 个' : ''}` : '没有找到。试试更短的关键词，例如“租约”“模型”或“MCP”。';
    for (const entry of matches.slice(0, 30)) {
      const link = document.createElement('a'); link.className = 'search-result'; link.href = `#${entry.id}`;
      const category = document.createElement('small'); category.textContent = entry.chapter;
      const title = document.createElement('strong'); title.textContent = entry.title;
      const snippet = document.createElement('p');
      const pos = entry.text.toLowerCase().indexOf(tokens[0]); const start = Math.max(0, pos - 30);
      snippet.textContent = `${start ? '…' : ''}${entry.text.slice(start, start + 135)}${entry.text.length > start + 135 ? '…' : ''}`;
      link.append(category, title, snippet);
      link.addEventListener('click', () => { dialog.close(); if (location.hash === link.hash) navigate(); });
      results.append(link);
    }
  }
  function renderStep() {
    const item = data.journey[step];
    for (const button of document.querySelectorAll('[data-step]')) {
      if (Number(button.dataset.step) === step) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    const values = { 'step-title': item.title, 'step-layer': item.layer, 'step-number': `节点 ${String(step + 1).padStart(2, '0')} / ${data.journey.length}`, 'step-input': item.input, 'step-action': item.action, 'step-output': item.output, 'step-note': item.detail, 'step-file': item.file, 'step-status': `${step + 1} / ${data.journey.length} · 教学演示，未连接服务` };
    for (const [id, value] of Object.entries(values)) document.getElementById(id).textContent = value;
    document.getElementById('step-prev').disabled = step === 0;
    document.getElementById('step-next').textContent = step === data.journey.length - 1 ? '从头再看 ↺' : '下一步 →';
  }
  for (const button of document.querySelectorAll('[data-step]')) button.addEventListener('click', () => { step = Number(button.dataset.step); renderStep(); });
  document.getElementById('step-prev').addEventListener('click', () => { step = Math.max(0, step - 1); renderStep(); });
  document.getElementById('step-next').addEventListener('click', () => { step = (step + 1) % data.journey.length; renderStep(); });
  renderStep();
  const historyInput = document.getElementById('history-count');
  const knowledgeInput = document.getElementById('knowledge-toggle');
  function contextLab() {
    const count = Math.max(1, Math.min(300, Math.floor(Number(historyInput.value) || 1)));
    const retained = Math.min(30, count);
    document.getElementById('lab-history').textContent = `近 ${retained} 条 user / assistant 消息`;
    document.getElementById('lab-knowledge').hidden = !knowledgeInput.checked;
    document.getElementById('lab-result').textContent = `数据库有 ${count} 条符合角色条件的消息（含当前问题），本次发给模型 ${retained} 条${count > retained ? `，更早的 ${count - retained} 条不发送` : ''}。${knowledgeInput.checked ? '检索成功时另注入最多五个片段。' : '本次不注入新的知识片段；旧回答仍可能包含知识。'}`;
  }
  historyInput.addEventListener('input', contextLab); knowledgeInput.addEventListener('change', contextLab); contextLab();
  let diagramScale = 1;
  let expandedDiagram;
  function resizeDiagram() {
    expandedDiagram.style.width = `${expandedDiagram.viewBox.baseVal.width * diagramScale}px`;
    document.getElementById('diagram-scale').textContent = `${Math.round(diagramScale * 100)}%`;
    document.getElementById('diagram-smaller').disabled = diagramScale <= 0.5;
    document.getElementById('diagram-larger').disabled = diagramScale >= 2;
  }
  for (const figure of document.querySelectorAll('.diagram-frame')) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'diagram-open-button'; button.textContent = '放大阅读 ↗';
    figure.querySelector('figcaption').append(button);
    button.addEventListener('click', () => {
      expandedDiagram = figure.querySelector('svg').cloneNode(true);
      for (const node of expandedDiagram.querySelectorAll('[id]')) node.id = `expanded-${node.id}`;
      expandedDiagram.setAttribute('aria-labelledby', `expanded-${expandedDiagram.getAttribute('aria-labelledby')}`);
      for (const path of expandedDiagram.querySelectorAll('[marker-end]')) path.setAttribute('marker-end', path.getAttribute('marker-end').replace('url(#', 'url(#expanded-'));
      document.getElementById('diagram-canvas').replaceChildren(expandedDiagram);
      diagramScale = 1; resizeDiagram(); diagramDialog.showModal();
    });
  }
  document.getElementById('diagram-close').addEventListener('click', () => diagramDialog.close());
  document.getElementById('diagram-smaller').addEventListener('click', () => { diagramScale = Math.max(0.5, diagramScale - 0.25); resizeDiagram(); });
  document.getElementById('diagram-larger').addEventListener('click', () => { diagramScale = Math.min(2, diagramScale + 0.25); resizeDiagram(); });
  for (const pre of document.querySelectorAll('pre')) {
    if (pre.closest('.diagram-source')) continue;
    const wrap = document.createElement('div'); wrap.className = 'code-wrap'; pre.before(wrap); wrap.append(pre);
    const copy = document.createElement('button'); copy.className = 'copy-button'; copy.type = 'button'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制这段代码'); wrap.append(copy);
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(pre.textContent); copy.textContent = '已复制';
      } catch {
        const range = document.createRange(); range.selectNodeContents(pre); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = '已选中，请复制';
      }
      setTimeout(() => { copy.textContent = '复制'; }, 2500);
    });
  }
  document.getElementById('print-current').addEventListener('click', () => { document.body.classList.remove('print-all'); window.print(); });
  document.getElementById('print-all').addEventListener('click', () => { document.body.classList.add('print-all'); window.print(); });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-all'));
  navigate(true);
})();
