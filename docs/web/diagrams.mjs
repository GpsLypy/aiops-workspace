// Offline reading views. Sequence/relations are parsed from the Markdown Mermaid
// blocks; architecture uses the same checked JSON specification as its viewer.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (x, y, value, extra = '') => `<text x="${x}" y="${y}" ${extra}>${escape(value)}</text>`;
const box = (x, y, w, h, title, sub = '') => `<rect class="diagram-node" x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/>${text(x + w / 2, y + (sub ? 31 : h / 2 + 5), title, 'text-anchor="middle" class="diagram-title"')}${sub ? text(x + w / 2, y + 54, sub, 'text-anchor="middle" class="diagram-caption"') : ''}`;
const line = (x1, y1, x2, y2, dashed = false) => `<path class="diagram-edge${dashed ? ' dashed' : ''}" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#ARROW)"/>`;
function wrap(id, width, height, title, body) {
  return `<svg class="doc-diagram" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${id}-title"><title id="${id}-title">${escape(title)}</title><defs><marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="currentColor"/></marker></defs>${body.replaceAll('#ARROW', `#${id}-arrow`)}</svg>`;
}

export function architectureDiagram(spec, id = 'system-map') {
  // A compact reading map; the full Archify viewer retains authored routes.
  const rows = [
    ['workspace', '浏览器', 'React 工作空间'], ['http', 'HTTP 校验', 'Cookie · JSON · 权限'],
    ['engine', 'Node 治理与桥接', '上下文 · 审批 · 执行台账'], ['model', '外部模型', 'Chat / Responses'],
  ];
  const known = spec.components.map(node => node.id).sort();
  const expected = ['workspace', 'http', 'engine', 'model', 'scheduler', 'store', 'knowledge', 'remote', 'worker'].sort();
  const edges = spec.connections.map(edge => `${edge.from}:${edge.to}`).sort();
  const expectedEdges = ['workspace:http', 'http:engine', 'engine:model', 'scheduler:engine', 'http:store', 'engine:knowledge', 'engine:remote', 'engine:worker'].sort();
  if (JSON.stringify(known) !== JSON.stringify(expected) || JSON.stringify(edges) !== JSON.stringify(expectedEdges)) throw new Error('Architecture topology changed: update the curated offline reading view');
  let body = rows.map(([, title, sub], i) => box(24 + i * 265, 170, 220, 80, title, sub)).join('');
  for (let i = 0; i < 3; i++) body += line(244 + i * 265, 210, 289 + i * 265, 210);
  body += box(554, 20, 220, 80, '任务调度', '到期后复用同一执行器') + line(664, 100, 664, 170);
  body += box(819, 20, 220, 80, 'AgentScope Worker', 'Python · 每轮独立 Agent');
  body += `<path class="diagram-edge" d="M714 170 V120 H929 V100" marker-end="url(#ARROW)"/>`;
  body += text(825, 111, 'stdio 编排回调', 'text-anchor="middle" class="diagram-caption"');
  body += box(24, 370, 250, 80, 'SQLite 与外置密钥', '执行 · 审批 · 审计 · 索引');
  body += box(424, 370, 220, 80, '知识检索', '授权文档的前五片段');
  body += box(819, 370, 220, 80, '远程 MCP', '复核授权后调用工具');
  body += `<path class="diagram-edge" d="M399 250 V310 H149 V370" marker-end="url(#ARROW)"/>`;
  body += `<path class="diagram-edge" d="M619 250 V310 H534 V370" marker-end="url(#ARROW)"/>`;
  body += `<path class="diagram-edge" d="M719 250 V310 H929 V370" marker-end="url(#ARROW)"/>`;
  body += text(664, 136, '创建者身份', 'text-anchor="middle" class="diagram-caption"');
  body += text(274, 301, '查询与保存', 'text-anchor="middle" class="diagram-caption"');
  body += text(827, 301, '工具请求与结果', 'text-anchor="middle" class="diagram-caption"');
  return wrap(id, 1060, 480, '系统架构：浏览器到 HTTP 校验、Node 治理桥接与模型；AgentScope Worker 统一编排，调度、知识、MCP 和 SQLite 提供支撑', body);
}

export function renderMermaid(source, id, spec) {
  if (source.startsWith('sequenceDiagram')) return sequence(source, id);
  if (source.startsWith('erDiagram')) return entities(source, id);
  if (source.startsWith('stateDiagram')) return states(source, id);
  if (source.includes('flowchart LR')) return architectureDiagram(spec, id);
  if (source.includes('flowchart TB')) return context(source, id);
  throw new Error(`Missing offline diagram renderer: ${id}`);
}

function sequence(source, id) {
  const participants = [...source.matchAll(/participant (\w+) as (.+)/g)].map(m => ({ id: m[1], name: m[2] }));
  const messages = source.split('\n').flatMap(row => {
    const m = row.trim().match(/^(\w+)(--?>>)(\w+):\s*(.+)$/);
    const note = row.trim().match(/^Note over (\w+):\s*(.+)$/);
    return m ? [{ from: m[1], to: m[3], label: m[4], dashed: m[2] === '-->>' }] : note ? [{ note: true, from: note[1], label: note[2] }] : [];
  });
  const width = 1140; const height = messages.length * 62 + 126;
  const x = key => 95 + participants.findIndex(p => p.id === key) * 190;
  let body = participants.map(p => box(x(p.id) - 87, 12, 174, 54, p.name) + `<path class="diagram-lifeline" d="M${x(p.id)} 66 V${height - 20}"/>`).join('');
  messages.forEach((m, i) => {
    const y = 112 + i * 62;
    if (m.note) {
      body += `<rect class="diagram-node" x="${x(m.from) - 155}" y="${y - 24}" width="440" height="42" rx="7"/>`;
      body += text(x(m.from) + 65, y + 2, m.label, 'text-anchor="middle" class="diagram-caption"');
      return;
    }
    const center = (x(m.from) + x(m.to)) / 2;
    body += line(x(m.from), y, x(m.to), y, m.dashed);
    body += `<rect class="diagram-label-bg" x="${Math.max(3, center - m.label.length * 6.1)}" y="${y - 25}" width="${m.label.length * 12.2}" height="21"/>`;
    body += text(center, y - 10, `${i + 1}. ${m.label}`, 'text-anchor="middle" class="diagram-caption"');
  });
  return wrap(id, width, height, '一次对话完整时序，按从上到下阅读请求与返回', body);
}

function context(source, id) {
  const definitions = [...source.matchAll(/(\w+)\[([^\]]+)\]/g)];
  const names = Object.fromEntries(definitions.map(m => [m[1], m[2]]));
  const systemInputs = ['Base', 'Agent', 'Skills', 'Knowledge'];
  let body = systemInputs.map((key, i) => box(22, 20 + i * 106, 360, 66, names[key])).join('');
  body += box(500, 180, 270, 74, names.System);
  systemInputs.forEach((key, i) => { body += line(382, 53 + i * 106, 500, 195 + i * 14); });
  body += box(500, 344, 270, 74, names.Input);
  body += line(635, 254, 635, 344);
  for (const [index, key] of ['History', 'Tools', 'Results'].entries()) {
    body += box(830, 166 + index * 116, 420, 74, names[key]);
    body += line(830, 203 + index * 116, 770, 360 + index * 18);
  }
  return wrap(id, 1274, 500, '模型输入包含一条系统消息、近三十条历史、工具定义及当轮工具结果', body);
}

function entities(source, id) {
  const edges = [...source.matchAll(/(\w+) \|\|--o\{ (\w+) : "([^"]+)"/g)].map(m => [m[1], m[2], m[3]]);
  const positions = { users: [450, 20], auth_sessions: [30, 190], resources: [310, 190], conversations: [590, 190], tasks: [870, 190], messages: [590, 370], task_runs: [870, 370] };
  let body = edges.map(([from, to, label]) => {
    const a = positions[from]; const b = positions[to];
    return line(a[0] + 110, a[1] + 65, b[0] + 110, b[1]) + text((a[0] + b[0]) / 2 + 110, (a[1] + b[1]) / 2 + 25, label, 'text-anchor="middle" class="diagram-caption"');
  }).join('');
  for (const [name, [x, y]] of Object.entries(positions)) body += box(x, y, 220, 65, name);
  return wrap(id, 1120, 475, '数据库显式外键关系；settings 与 audit 为独立表，其他关联见正文', body);
}

function states(source, id) {
  const edges = [...source.matchAll(/^\s*([^\n]+?) --> ([^:\n]+):\s*([^\n]+)/gm)].map(m => [m[1].trim(), m[2].trim(), m[3]]);
  const outcomes = edges.filter(([from]) => from === 'running');
  let body = box(370, 20, 360, 70, '等待计划', '任务已保存，尚未领取');
  body += line(550, 90, 550, 180) + text(570, 140, '到期 / 立即执行，事务领取', 'class="diagram-caption"');
  body += box(370, 180, 360, 70, 'running · 执行中', '180 秒任务租约，调用同一 Agent');
  outcomes.forEach(([, to, label], i) => {
    const x = 20 + i * 370;
    body += line(490 + i * 60, 250, x + 160, 370);
    body += box(x, 370, 320, 80, to, label);
  });
  body += text(550, 501, '每次运行记录终态不再回退；Cron 后续周期创建新的运行记录。', 'text-anchor="middle" class="diagram-caption"');
  return wrap(id, 1100, 530, '任务执行状态：running 到 success、failed 或 interrupted', body);
}
