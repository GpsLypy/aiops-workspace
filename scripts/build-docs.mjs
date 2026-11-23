import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Marked, Renderer } from 'marked';
import { chapters, journey } from '../docs/web/content.mjs';
import { renderMermaid } from '../docs/web/diagrams.mjs';
import { buildRequestFlow } from './build-request-flow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'docs/site');
const output = resolve(outputDir, 'index.html');
const check = process.argv.includes('--check');
buildRequestFlow({ root, check });
const read = path => readFileSync(resolve(root, path), 'utf8');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sources = new Map(chapters.map(chapter => [resolve(root, chapter.file), chapter.id]));
const spec = JSON.parse(read('docs/diagrams/architecture.json'));
const style = read('docs/web/site.css');
const script = read('docs/web/site.js');
const brandSource = read('src/assets/baixiaosheng.svg');
const brandIcon = `data:image/svg+xml;base64,${Buffer.from(brandSource).toString('base64')}`;
const manifests = new Map();
const failures = [];
let linksChecked = 0;
let diagramCount = 0;

function resolveLink(href, file) {
  if (/^(https?:|mailto:)/.test(href)) return { external: true, href };
  if (href.startsWith('#')) return { href };
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) throw new Error(`Unsupported link protocol in ${file}: ${href}`);
  const path = resolve(dirname(resolve(root, file)), decodeURIComponent(href.split('#')[0]));
  linksChecked++;
  if (path !== output && !existsSync(path)) failures.push(`${file}: missing local link ${href}`);
  const chapter = sources.get(path);
  if (chapter) return { href: `#${chapter}` };
  if (path === output) return { href: '#overview' };
  if (path === resolve(outputDir, 'architecture.html')) return { href: 'architecture.html' };
  return { source: relative(root, path).replaceAll('\\', '/') };
}

function renderChapter(chapter, index) {
  const markdown = read(chapter.file);
  manifests.set(chapter.file, createHash('sha256').update(markdown).digest('hex'));
  let heading = 0;
  let diagram = 0;
  const renderer = new Renderer();
  renderer.heading = function(token) {
    const id = `${chapter.id}-s${++heading}`;
    return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  };
  renderer.link = function(token) {
    const link = resolveLink(token.href, chapter.file);
    const label = this.parser.parseInline(token.tokens);
    if (link.source) return `<span class="source-reference" title="源码位置：${escape(link.source)}">${label}<span class="sr-only">（源码：${escape(link.source)}）</span></span>`;
    return `<a href="${escape(link.href)}"${link.external ? ' rel="noreferrer"' : ''}>${label}</a>`;
  };
  const codeRenderer = Renderer.prototype.code;
  renderer.code = function(token) {
    if (token.lang?.trim() !== 'mermaid') return codeRenderer.call(this, token);
    const id = `${chapter.id}-diagram-${++diagram}`; diagramCount++;
    return `<figure class="diagram-frame"><div class="diagram-scroll" tabindex="0" aria-label="图示，可横向滚动">${renderMermaid(token.text, id, spec)}</div><figcaption class="diagram-caption-bar">离线图示 · 阅读方向与例外见正文 · 小屏幕可横向滚动</figcaption><details class="diagram-source"><summary>查看 Mermaid 图源</summary><pre><code>${escape(token.text)}</code></pre></details></figure>`;
  };
  const tableRenderer = Renderer.prototype.table;
  renderer.table = function(token) { return `<div class="table-scroll" tabindex="0" role="region" aria-label="参考表格，可横向滚动">${tableRenderer.call(this, token)}</div>`; };
  const parser = new Marked({ renderer, gfm: true });
  const html = parser.parse(markdown).replace('</h1>', `</h1>${chapter.id === 'context' ? contextLab() : ''}`);
  const previous = chapters[index - 1]; const next = chapters[index + 1];
  const pagination = `<nav class="chapter-pagination" aria-label="相邻章节">${previous ? `<a href="#${previous.id}"><small>← 上一章</small>${escape(previous.title)}</a>` : ''}${next ? `<a href="#${next.id}"><small>下一章 →</small>${escape(next.title)}</a>` : ''}</nav>`;
  return `<section class="chapter" id="${chapter.id}" data-chapter="${chapter.id}" aria-label="${escape(chapter.title)}"><div class="chapter-source">阅读原稿 · ${escape(chapter.file)} · 以当前源码实现为准</div><div class="prose">${html}</div>${pagination}</section>`;
}

function contextLab() {
  return `<div class="context-lab js-only"><h3>试着组装一次上下文</h3><p>教学演示：假定消息角色均为 user / assistant，条数包含本次问题。它不读取你的真实会话。</p><div class="lab-controls"><label for="history-count">已保存消息数 <input id="history-count" type="number" min="1" max="300" value="48"></label><label><input id="knowledge-toggle" type="checkbox" checked>本轮启用知识检索</label></div><div class="context-stack"><div class="context-layer">system · 基础指令、子领域与 Skill<span>总长度最多 80,000 字符</span></div><div class="context-layer" id="lab-knowledge">system 内的参考知识<span>检索成功时最多五个片段</span></div><div class="context-layer"><strong id="lab-history">近 30 条 user / assistant 消息</strong><span>每条最多 20,000 字符</span></div><div class="context-layer">tools · 已授权的工具定义<span>与 messages 分开提交</span></div></div><div id="lab-result" class="lab-result" role="status"></div></div>`;
}

function navigation() {
  const groups = [...new Set(chapters.map(c => c.group))];
  return groups.map(group => `<div class="nav-group"><p>${escape(group)}</p>${chapters.filter(c => c.group === group).map(c => `<a class="nav-link" href="#${c.id}"><span class="nav-dot" aria-hidden="true"></span>${escape(c.title)}</a>`).join('')}</div>`).join('');
}

function home() {
  const first = journey[0];
  return `<div class="home" id="home">
  <section class="hero" aria-label="项目介绍"><div><div class="eyebrow">知识、方法与行动，在这里连接</div><h1>让一条运维问题，<br><span>有来处，也有去处。</span></h1><p class="lead">运维百晓生，把手册、诊断流程和远程工具组织成一个可追踪的工作空间。从第一次提问，到理解每个处理节点，这里陪你从零接手。</p><div class="hero-actions"><a class="button-link primary" href="#start">从零开始使用 <span aria-hidden="true">↗</span></a><a class="button-link" href="#conversation">看懂一次完整对话 <span aria-hidden="true">→</span></a></div><p class="hero-note">React + Node.js + SQLite · 单实例部署 · 模型与工具按需连接</p></div>
  <div class="specimen" aria-label="教学示例：一条问题连接知识、指令和工具"><div class="specimen-heading"><i class="signal"></i> 一条消息的处理档案 <span>教学示意</span></div><div class="specimen-question"><small>用户的问题</small>计费服务超时了。<br>请先查询状态，再按手册给出排查建议。</div><div class="specimen-path"><div class="specimen-node">核对身份与资源范围<span>后端检查权限</span></div><div class="specimen-node">检索手册，加载诊断指令<span>知识库 + Skill</span></div><div class="specimen-node">模型提出查询，后端执行<span>已授权的 MCP</span></div><div class="specimen-node">根据结果，组织最终回答<span>模型分析</span></div></div><div class="specimen-result"><span aria-hidden="true">✓</span> 回答 · 来源 · 工具摘要<span>保存到会话</span></div></div></section>
  <div class="concept-strip"><div class="concept"><small>KNOWLEDGE</small><strong>知识库</strong><p>沉淀稳定事实：知道什么</p></div><div class="concept"><small>SKILL</small><strong>工作指令</strong><p>说明步骤方法：怎样处理</p></div><div class="concept"><small>MCP</small><strong>远程工具</strong><p>读取实时状态：实际行动</p></div><div class="concept"><small>AGENT</small><strong>执行编排</strong><p>连接这些能力：完成一轮</p></div></div>
  <section aria-labelledby="journey-heading"><div class="section-kicker"><div><h2 id="journey-heading">跟着一条消息，走完整个系统。</h2><p>从输入到保存，逐步看清每个节点的输入、处理和输出。</p></div><a href="#conversation">阅读全文 →</a></div><div class="journey"><div class="journey-top"><span class="demo-label">可交互教学</span><span>示例问题：检查 billing 状态，并结合手册分析</span></div><div class="journey-layout"><div class="journey-steps" role="group" aria-label="选择处理节点">${journey.map((item, i) => `<button class="step-button" type="button" data-step="${i}"${i === 0 ? ' aria-current="step"' : ''}><span>${String(i + 1).padStart(2, '0')}</span>${escape(item.title)}</button>`).join('')}</div><div class="step-detail" aria-live="polite" aria-atomic="true"><div class="step-layer"><span id="step-layer">${first.layer}</span><span id="step-number">节点 01 / ${journey.length}</span></div><h3 id="step-title">${first.title}</h3><dl><dt>输入 INPUT</dt><dd id="step-input">${first.input}</dd><dt>这一节点做什么</dt><dd id="step-action">${first.action}</dd><dt>交给下一步 OUTPUT</dt><dd id="step-output">${first.output}</dd></dl><p id="step-note" class="detail-note">${first.detail}</p><div id="step-file" class="step-file">${first.file}</div></div></div><div class="journey-controls"><span id="step-status">1 / ${journey.length} · 教学演示，未连接服务</span><div class="js-only"><button type="button" id="step-prev" disabled>← 上一步</button><button type="button" id="step-next">下一步 →</button></div></div></div></section>
  <div class="roadmap"><a href="#start" class="road-card"><small>我第一次使用</small><h3>先跑通，再理解</h3><p>安装、模型配置和第一次真实对话。</p><span class="arrow">↗</span></a><a href="#context" class="road-card"><small>我想看懂原理</small><h3>拆开上下文</h3><p>为什么调用工具，为什么忘记前文。</p><span class="arrow">↗</span></a><a href="#operations" class="road-card"><small>我准备接手</small><h3>从使用到维护</h3><p>部署、排错、备份和源码修改入口。</p><span class="arrow">↗</span></a></div>
   <div class="quickstart"><div><h3>从你的电脑开始。</h3><p>准备 Node.js ≥ 22.16，在项目根目录运行。<br>打开 localhost:5173，创建首个管理员，再配置模型。<br><a href="#production">生产治理、审批与上线门禁 →</a></p></div><pre><code>npm ci\nnpm run dev</code></pre></div>
  </div>`;
}

const rendered = chapters.map(renderChapter).join('\n');
// Check the project entry documentation too, without embedding duplicate prose.
const entryParser = new Marked();
entryParser.walkTokens(entryParser.lexer(read('README.md')), token => { if (token.type === 'link') resolveLink(token.href, 'README.md'); });
if (failures.length) throw new Error(failures.join('\n'));
const sourceDigest = createHash('sha256').update(JSON.stringify([...manifests])).update(style).update(script).update(brandSource).update(read('docs/web/content.mjs')).update(read('docs/web/diagrams.mjs')).update(JSON.stringify(spec)).digest('hex');
const data = JSON.stringify({ chapters: chapters.map(({ file, ...rest }) => rest), journey }).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="运维百晓生：连接知识库、Skill 与 MCP 的 AI 运维工作空间。面向初学者的完整架构、对话流程、上下文、部署与接手手册。"><meta name="color-scheme" content="light dark"><link rel="icon" type="image/svg+xml" sizes="any" href="${brandIcon}"><title>运维百晓生 · 从知识到行动</title><style>${style}</style></head>
<body><a class="skip-link" href="#main">跳到正文</a><header class="topbar"><button class="icon-button mobile-menu js-only" id="menu-toggle" aria-label="打开学习目录" aria-expanded="false" aria-controls="sidebar">☰</button><a class="brand" href="#overview"><img class="brand-mark" src="${brandIcon}" width="36" height="36" alt="" aria-hidden="true"><span><strong>运维百晓生</strong><small>AIOPS WORKSPACE</small></span></a><span class="version">1.0.0 · 项目官网</span><nav class="top-links" aria-label="快捷导航"><a href="#start">开始使用</a><a href="#architecture">架构设计</a><a href="#operations">接手指南</a></nav><button class="search-trigger js-only" id="search-open" aria-haspopup="dialog"><span>⌕ 搜索手册</span><kbd>⌘ / Ctrl K</kbd></button><button class="icon-button js-only" id="theme-toggle" aria-label="切换深色主题">◐</button></header><div class="reading-progress" id="reading-progress" aria-hidden="true"></div>
<aside class="sidebar" id="sidebar"><div class="sidebar-label"><span>项目学习手册</span><span>入门 → 接手</span></div><nav aria-label="学习目录">${navigation()}</nav><div class="sidebar-foot"><strong>● 完整内容，可离线阅读</strong><br>按真实代码核对 · 2026-09-19<br>示例演示不调用模型或工具。<br><a href="architecture.html">打开独立架构查看器 ↗</a></div></aside>
<main class="site-main" id="main"><div class="content-shell"><div class="breadcrumb"><span>项目手册</span><span class="slash">/</span><span id="current-chapter">认识运维百晓生</span><div class="page-tools js-only"><button class="text-button" id="print-current">打印本章</button><button class="text-button" id="print-all">打印全部</button></div></div><noscript><p class="noscript-note">JavaScript 未启用：全部文档已按顺序展开，仍可阅读并使用浏览器查找。步骤演示、搜索面板和主题切换需要启用 JavaScript。</p></noscript>${home()}<div class="reader-layout"><div class="reader">${rendered}</div><aside class="outline" aria-label="本章目录"><strong>本章内容</strong><nav id="outline-links"></nav></aside></div><footer class="site-footer"><span>运维百晓生 · 把原理讲清，把流程走通。</span><span>文档基于当前实现 · <a href="#site-guide">维护这份官网</a> · <a href="#overview">回到首页 ↑</a></span></footer></div></main>
<dialog id="search-dialog" class="search-dialog" aria-label="搜索完整项目手册"><div class="search-head"><label class="sr-only" for="search-input">搜索关键词</label><input type="search" id="search-input" placeholder="搜索流程、工具、上下文、部署…" autocomplete="off"><button type="button" id="search-close">关闭 Esc</button></div><p id="search-status" class="search-status" role="status"></p><div id="search-results" class="search-results"></div></dialog>
<dialog id="diagram-dialog" class="diagram-dialog" aria-label="放大阅读图示"><div class="diagram-dialog-head"><p>图示阅读 · 可滚动查看完整内容</p><div><button type="button" id="diagram-smaller" aria-label="缩小图示">−</button><span id="diagram-scale" role="status">100%</span><button type="button" id="diagram-larger" aria-label="放大图示">＋</button><button type="button" id="diagram-close">关闭 Esc</button></div></div><div id="diagram-canvas" class="diagram-canvas" tabindex="0" role="region" aria-label="可横向和纵向滚动的完整图示"></div></dialog>
<script id="site-data" type="application/json">${data}</script><script>${script}</script>
<!-- Deterministic sources SHA-256: ${sourceDigest}; ${chapters.length} chapters; ${diagramCount} diagrams. -->
</body></html>\n`;

function checkHtml(value) {
  const ids = [...value.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error('Generated site has duplicate IDs');
  for (const [, href] of value.matchAll(/\bhref="([^"]+)"/g)) {
    if (href.startsWith('#') && !unique.has(href.slice(1))) throw new Error(`Broken site anchor: ${href}`);
    if (!href.startsWith('#') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) && !existsSync(resolve(outputDir, href))) throw new Error(`Missing site asset: ${href}`);
  }
  for (const [, src] of value.matchAll(/\bsrc="([^"]+)"/g)) {
    if (!src.startsWith('data:') && !existsSync(resolve(outputDir, src))) throw new Error(`Missing local resource: ${src}`);
  }
  for (const chapter of chapters) if (!unique.has(chapter.id)) throw new Error(`Missing chapter ${chapter.id}`);
}
checkHtml(html);
if (check) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== html) throw new Error('Documentation site is stale. Run npm run docs:build, then npm run docs:check.');
  console.log(`Docs check passed: ${chapters.length} chapters, ${diagramCount} offline diagrams, ${linksChecked} local source links; HTML, anchors and assets are current.`);
} else {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(output, html);
  console.log(`Built docs/site/index.html: ${chapters.length} chapters, ${diagramCount} offline diagrams, ${Buffer.byteLength(html).toLocaleString()} bytes.`);
}
