import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, CheckCircle2, Download, ExternalLink, FileSpreadsheet, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, dateText, errorText, type Resource, type User } from '../api';
import type { Page } from '../data';
import { Button } from './ui';
import '../local-deployment.css';

type Service = { id: 'collector' | 'tempo' | 'prometheus' | 'sandbox'; label: string; status: 'online' | 'offline' | 'unconfigured'; message: string; endpoint: string | null };
type Evidence = { measuredAt: string | null; passed: boolean | null; checks: { label: string; passed: boolean }[] };
type Deployment = { checkedAt: string; services: Service[]; evidence: { observability: Evidence; sandbox: Evidence }; billing: { available: boolean; realInvoiceLoaded: boolean } };
type BillingFile = { filename: string; content: string };
type BillingResult = { generatedAt: string; status: 'matched' | 'needs_review'; costsMatch: boolean; tokensMatch: boolean;
  counts: { usageRows: number; invoiceRows: number; groups: number; differences: number; usageOnly: number; invoiceOnly: number };
  totals: { currency: string; estimatedCost: string; billedUsageCost: string; billedAdjustments: string; billedNetCost: string }[];
  rows: { date: string; provider: string; model: string; currency: string; status: string; estimatedCost: string; billedUsageCost: string; costDifference: string | null; tokenDifference: string | null }[] };
const usageSample: BillingFile = { filename: 'example-usage.csv', content: 'date,provider,model,currency,tokens,tokenSource,estimatedCost\n2026-10-08,example,example-model,USD,1000,reported,0.100000\n' };
const invoiceSample: BillingFile = { filename: 'example-invoice.csv', content: 'date,provider,model,currency,tokens,billedCost,category\n2026-10-08,example,example-model,USD,1000,0.120000,usage\n' };

function download(value: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Proof({ title, evidence }: { title: string; evidence?: Evidence }) {
  return <details className="local-proof"><summary>{title}</summary>{evidence?.measuredAt ? <>
    <p>记录时间：{dateText(evidence.measuredAt)} · {evidence.passed ? '该次验收通过' : '该次验收有未通过项'}</p>
    <ul>{evidence.checks.map((check, index) => <li key={index}><span className={check.passed ? 'passed' : 'failed'}>{check.passed ? '已验证' : '未通过'}</span>{check.label}</li>)}</ul>
    <p>这是已保存的服务验收记录；上方状态是本次连通检查。它们不表示当前生产环境已通过验收。</p>
  </> : <p>尚未找到可展示的验收记录。服务连通状态可单独检查。</p>}</details>;
}

export default function LocalDeployment({ user, resources, go }: { user: User; resources: Resource[]; go: (page: Page) => void }) {
  const [deployment, setDeployment] = useState<Deployment>();
  const [checking, setChecking] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [usage, setUsage] = useState<BillingFile>();
  const [invoice, setInvoice] = useState<BillingFile>();
  const [result, setResult] = useState<BillingResult>();
  const [billingError, setBillingError] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [example, setExample] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const statusRequest = useRef<AbortController | undefined>(undefined);
  const billingRequest = useRef<AbortController | undefined>(undefined);
  const fileReads = useRef({ usage: 0, invoice: 0 });
  const generation = useRef(0);
  const admin = user.role === 'admin';
  const sandboxConnected = resources.some(resource => resource.kind === 'mcp' && resource.status === '已启用' && resource.allowedTools.includes('sandbox_execute_python'));

  const refresh = async () => {
    statusRequest.current?.abort();
    const request = new AbortController(); statusRequest.current = request;
    setChecking(true); setStatusError('');
    try { const value = await api<Deployment>('/local-services', { signal: request.signal }); if (!request.signal.aborted) setDeployment(value); }
    catch (error) { if (!request.signal.aborted) { setDeployment(undefined); setStatusError(errorText(error)); } }
    finally { if (!request.signal.aborted) setChecking(false); }
  };
  useEffect(() => {
    if (admin) void refresh();
    return () => { statusRequest.current?.abort(); billingRequest.current?.abort(); generation.current++; fileReads.current.usage++; fileReads.current.invoice++; };
  }, [admin]);

  const invalidateBill = () => { generation.current++; billingRequest.current?.abort(); setResult(undefined); setBillingBusy(false); setBillingError(''); setExample(false); };
  const selectFile = async (file: File | undefined, kind: 'usage' | 'invoice') => {
    invalidateBill();
    const current = ++fileReads.current[kind];
    const setter = kind === 'usage' ? setUsage : setInvoice;
    setter(undefined);
    if (!file) return;
    try {
      if (!/\.(csv|json)$/i.test(file.name)) throw new Error('请选择 CSV 或 JSON 文件。');
      if (file.size > 400 * 1024) throw new Error('页面导入每份文件最多 400 KiB；更大的文件可使用本机对账命令。');
      const content = await file.text();
      if (current === fileReads.current[kind]) setter({ filename: file.name, content });
    } catch (error) { if (current === fileReads.current[kind]) setBillingError(errorText(error)); }
  };
  const reconcile = async () => {
    if (!usage || !invoice) return;
    const current = ++generation.current;
    billingRequest.current?.abort(); const request = new AbortController(); billingRequest.current = request;
    setBillingBusy(true); setBillingError(''); setResult(undefined);
    try {
      const value = await api<BillingResult>('/local-services/billing', { method: 'POST', signal: request.signal, body: JSON.stringify({ usage, invoice }) });
      if (current === generation.current && !request.signal.aborted) setResult(value);
    } catch (error) { if (current === generation.current && !request.signal.aborted) setBillingError(errorText(error)); }
    finally { if (current === generation.current && !request.signal.aborted) setBillingBusy(false); }
  };
  const status = (id: Service['id']) => deployment?.services.find(service => service.id === id);
  const state = (service?: Service) => checking ? '正在检查' : service?.status === 'online' ? service.id === 'collector' ? '接收入口可达' : service.id === 'sandbox' ? 'MCP 入口可达' : '就绪检查通过' : service?.status === 'offline' ? '本机暂不可连接' : service?.status === 'unconfigured' ? '未配置本机部署' : '尚未检查';

  return <div className="local-deployment">
    <section className="local-intro" aria-labelledby="local-intro-title">
      <div><span className="as-guide-eyebrow">已经做了什么 · 现在怎么用</span><h2 id="local-intro-title">把处理过程看清楚，把费用和代码执行管起来</h2><p>观测服务记录问答的路径与耗时；账单工具比较调用估算和供应商费用；沙箱为经过批准的 Python 计算提供独立运行空间。</p></div>
      <div className="local-status-actions">{admin ? <Button onClick={() => void refresh()} disabled={checking}><RefreshCw size={14} aria-hidden="true" />{checking ? '正在检查' : '刷新本机状态'}</Button> : <p>服务状态与账单导入由管理员查看。</p>}<span>{deployment ? `检查时间：${dateText(deployment.checkedAt)}` : '打开此页不会调用模型或执行代码。'}</span></div>
      {statusError && <p className="inline-error" role="alert">无法取得本机状态：{statusError}。可点击「刷新本机状态」重试。</p>}
    </section>

    <section className="local-section" aria-labelledby="local-observability-title">
      <div className="local-section-heading"><Activity size={21} aria-hidden="true" /><div><h2 id="local-observability-title">观测：这次问答慢在哪里，执行了哪些步骤</h2><p>三个服务各负责一件事，不需要记住它们的名字才能开始使用。</p></div></div>
      <div className="local-flow" aria-label="问答数据的两条观测路径"><span>一轮问答完成</span><div><p><strong>处理路径</strong><ArrowRight size={14} aria-hidden="true" /><span>Collector 接收</span><ArrowRight size={14} aria-hidden="true" /><span>Tempo 保存</span></p><p><strong>次数与耗时</strong><ArrowRight size={14} aria-hidden="true" /><span>Prometheus 汇总统计</span></p></div></div>
      <div className="local-service-list">{[
        { id: 'collector' as const, name: 'Collector', purpose: '接收问答过程', detail: '收集问答各阶段的时间和关联标识，再交给链路存储。关闭它不会阻断正常问答。', use: '问答完成后自动接收，不需要在这里手动发送。' },
        { id: 'tempo' as const, name: 'Tempo', purpose: '保存一轮问答的路径', detail: '把同一轮的模型、工具等阶段串起来，供你按 trace ID 查回；重启后仍保留已存链路。', use: 'trace ID 可从回答的「问答全景」中导出；目前通过查询接口查回链路。' },
        { id: 'prometheus' as const, name: 'Prometheus', purpose: '查看次数、耗时和失败趋势', detail: '按工作空间统计完成轮次、阶段耗时和出口故障，帮助判断问题是偶发还是持续出现。', use: '点击「打开统计页面」即可查看本机统计。' },
      ].map(item => <article className="local-service" key={item.id}><div className="local-service-name"><strong>{item.name}</strong><span className={`local-state ${status(item.id)?.status || ''}`} role="status">{state(status(item.id))}</span></div><div><h3>{item.purpose}</h3><p>{item.detail}</p><p className="local-use">{item.use}</p>{status(item.id) && <p className="local-check-message">{status(item.id)?.message}</p>}</div>{item.id === 'prometheus' && status(item.id)?.status === 'online' ? <a className="local-action" href="http://localhost:9090" target="_blank" rel="noopener noreferrer">打开统计页面<ExternalLink size={13} aria-hidden="true" /></a> : item.id === 'tempo' && status(item.id)?.status === 'online' ? <span className="local-endpoint">本机查询接口<br /><code>localhost:3200</code></span> : <span />}</article>)}</div>
      <details className="local-how"><summary>在统计页面先查什么</summary><p>打开 Prometheus 后，在查询框粘贴下列任一表达式并执行：</p><dl><dt>当前进程完成的问答轮次</dt><dd><code>aiops_agent_trace_duration_seconds_count&#123;stage="run"&#125;</code></dd><dt>最近五分钟各阶段的 P95 耗时</dt><dd><code>aiops:fleet_stage_p95_seconds:rate5m</code></dd><dt>问答链路发送失败的频率</dt><dd><code>aiops:fleet_otlp_exports:rate5m</code></dd></dl><p>没有产生新问答时可能暂无结果；进程重启会重置轮次计数。这里统计处理过程，业务健康仍需实时工具证据。</p></details>
      <Proof title="展开观测服务的实际验收记录" evidence={deployment?.evidence.observability} />
    </section>

    <section className="local-section" aria-labelledby="local-billing-title">
      <div className="local-section-heading"><FileSpreadsheet size={21} aria-hidden="true" /><div><h2 id="local-billing-title">账单：调用估算和供应商费用是否一致</h2><p>按日期、供应商、模型和币种比较金额与 tokens，列出差额和缺失项。不同币种分别计算。</p></div></div>
      <p className="local-notice">已提供对账工具；尚未保存真实供应商账单。导入的数据仅在本次请求中计算，不保存到服务器，也不发送给模型。</p>
      {admin ? <>
        <div className="local-billing-files"><label>调用用量文件 <small>CSV / JSON · 最多 400 KiB</small><input key={`usage-${fileVersion}`} type="file" accept=".csv,.json" onChange={event => void selectFile(event.target.files?.[0], 'usage')} /><span>{usage?.filename || '选择已整理的调用用量与估算费用'}</span></label><label>供应商账单文件 <small>CSV / JSON · 最多 400 KiB</small><input key={`invoice-${fileVersion}`} type="file" accept=".csv,.json" onChange={event => void selectFile(event.target.files?.[0], 'invoice')} /><span>{invoice?.filename || '选择供应商导出的标准化费用明细'}</span></label></div>
        <div className="local-billing-actions"><Button onClick={() => { invalidateBill(); fileReads.current.usage++; fileReads.current.invoice++; setUsage(usageSample); setInvoice(invoiceSample); setExample(true); setFileVersion(value => value + 1); }}>载入演示数据</Button><Button primary disabled={!usage || !invoice || billingBusy} onClick={() => void reconcile()}>{billingBusy ? '正在对账' : '开始对账'}</Button><span>{example ? '演示数据：估算 0.10 USD，账单 0.12 USD；预期差额 0.02 USD。' : '先选两份文件，再开始对账。'}</span></div>
        {billingError && <p className="inline-error" role="alert">{billingError}</p>}
        {result && <div className="local-billing-result" aria-label="账单对账结果" aria-live="polite"><div><h3>{result.status === 'matched' ? '金额与用量一致' : '有差额或待核对项'}{example && <small>演示结果</small>}</h3><Button onClick={() => download(JSON.stringify(result, null, 2), 'billing-reconciliation.json', 'application/json')}><Download size={13} aria-hidden="true" />下载对账结果</Button></div><p>{result.counts.usageRows} 条调用记录、{result.counts.invoiceRows} 条账单记录；金额{result.costsMatch ? '一致' : '待核对'}，tokens {result.tokensMatch ? '一致' : '待核对'}。来源未验证或缺少 tokens 时仍需复核。</p><div className="local-table-scroll" role="region" aria-label="费用差额明细" tabIndex={0}><table><caption>费用差额明细（最多展示前 50 项，下载包含全部结果）</caption><thead><tr><th>日期 / 模型</th><th>估算费用</th><th>账单用量费</th><th>差额</th></tr></thead><tbody>{result.rows.slice(0, 50).map((row, index) => <tr key={index}><th scope="row">{row.date}<small>{row.provider} / {row.model}</small></th><td>{row.estimatedCost} {row.currency}</td><td>{row.billedUsageCost} {row.currency}</td><td>{row.costDifference === null ? '缺少一侧记录' : `${row.costDifference} ${row.currency}`}<small>{row.status === 'matched' ? '金额匹配' : row.status === 'difference' ? '有差异' : row.status === 'usage_only' ? '仅调用记录' : '仅账单记录'}</small></td></tr>)}</tbody></table></div>{result.totals.map(total => <p key={total.currency}>币种 {total.currency}：估算 {total.estimatedCost}，账单用量费 {total.billedUsageCost}，抵扣/调整 {total.billedAdjustments}，账单净额 {total.billedNetCost}。</p>)}</div>}
      </> : <p>请联系管理员导入用量与账单，查看实际对账结果。</p>}
      <details className="local-how"><summary>文件格式与样例下载</summary><p>使用整理后的明细，保留费用字段即可。页面不会从供应商账户自动下载账单。</p><p>用量列：<code>date, provider, model, currency, tokens, tokenSource, estimatedCost</code>。tokenSource 为 reported / estimated / unknown。</p><p>账单列：<code>date, provider, model, currency, billedCost, category</code>，tokens 可选。category 为 usage / credit / other。</p><p>日期使用 UTC 日，金额保留最多六位小数。JSON 格式为 schemaVersion=1、kind=usage 或 invoice、records 数组；estimatedCost 与 billedCost 必须是字符串，例如 "0.120000"，避免金额精度损失。</p><div className="local-billing-actions"><Button onClick={() => download(usageSample.content, 'example-usage.csv', 'text/csv')}>下载用量样例</Button><Button onClick={() => download(invoiceSample.content, 'example-invoice.csv', 'text/csv')}>下载账单样例</Button></div></details>
    </section>

    <section className="local-section" aria-labelledby="local-sandbox-title">
      <div className="local-section-heading"><ShieldCheck size={21} aria-hidden="true" /><div><h2 id="local-sandbox-title">独立沙箱：批准后计算，检查后下载</h2><p>用于 Python 计算和生成文本报表，让代码在临时容器里运行，再回收整个运行空间。</p></div><span className={`local-state ${status('sandbox')?.status || ''}`} role="status">{state(status('sandbox'))}</span></div>
      <ol className="local-sandbox-steps"><li><strong>提交固定代码</strong><p>选择源码与任务标识；审批后不能换成另一份代码。</p></li><li><strong>另一位管理员审批</strong><p>在执行中心核对本次操作，批准后才开始运行。</p></li><li><strong>隔离计算与清理</strong><p>禁网、只读根和资源限额；超时或取消后核对回收。</p></li><li><strong>预览产物，再批准下载</strong><p>文本通过扫描后，独立管理员预览并批准同一份内容。</p></li></ol>
      <div className="local-sandbox-use"><div><h3>现在可以怎么用</h3><p>{sandboxConnected ? '当前可见工作空间已配置代码工具允许列表，实际使用前仍需核对身份、范围、固定写计划与独立审批。' : '独立服务与本机命令已提供，当前可见工作空间还没有启用代码工具允许列表。管理员需要先配置 MCP、写操作范围和独立审批，才能在 Agent 中使用。'}</p>{status('sandbox') && <p className="local-check-message">{status('sandbox')?.message}</p>}<Button onClick={() => go('mcp')}>查看 MCP 接入<ArrowRight size={13} aria-hidden="true" /></Button></div><div><h3>首期支持范围</h3><p>Python 3.12；UTF-8 的 TXT、JSON、CSV 产物。源码最多 64 KiB，单次代码运行限时 10 秒；不支持上传输入、自定义网络或宿主目录。</p><p>Docker 与宿主共享内核；本机验收已覆盖的项目在下方展示，生产隔离需要另行验收。</p></div></div>
      <Proof title="展开独立沙箱的实际验收记录" evidence={deployment?.evidence.sandbox} />
      <p className="local-check-message">上方沙箱状态检查 MCP 入口是否响应；能否执行本次代码，还需核对执行服务、容量与审批。展开记录可查看此前实际执行和回收的验收结果。</p>
    </section>
    <footer className="local-deployment-footer"><CheckCircle2 size={16} aria-hidden="true" /><p>当前服务连通、已有验收记录、真实账单对账和生产批准分别展示。查看页面与刷新状态不会调用模型或运行用户代码。</p></footer>
  </div>;
}
