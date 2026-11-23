import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Download, FileCode2 } from 'lucide-react';
import { learningLessons } from '../agent-learning';
import { Button } from './ui';
import '../agent-learning.css';

type Reflection = { notes: string; assessment: string };
const assessments = ['未自评', '需要提示', '能讲清原理', '能结合源码复现'];

export default function AgentLearning() {
  const [selected, setSelected] = useState(0);
  const [reflections, setReflections] = useState<Record<string, Reflection>>({});
  const [feedback, setFeedback] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const feedbackOperation = useRef(0);
  const lesson = learningLessons[selected];
  const reflection = reflections[lesson.id] ?? { notes: '', assessment: assessments[0] };
  const assessed = Object.values(reflections).filter(item => item.assessment !== assessments[0]).length;

  useEffect(() => () => { feedbackOperation.current += 1; }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 4500);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  function updateReflection(change: Partial<Reflection>) {
    setReflections(current => ({ ...current, [lesson.id]: { ...reflection, ...change } }));
  }

  function moveTo(index: number) {
    feedbackOperation.current += 1;
    setSelected(index);
    setFeedback('');
    window.requestAnimationFrame(() => heading.current?.focus());
  }

  async function copyCommand() {
    const operation = ++feedbackOperation.current;
    setFeedback('');
    try {
      await navigator.clipboard.writeText(lesson.command);
      if (operation === feedbackOperation.current) setFeedback('已复制实验命令；请在仓库根目录手动运行。');
    } catch {
      if (operation === feedbackOperation.current) setFeedback('浏览器未允许复制，请选中命令后手动复制。');
    }
  }

  function downloadNotes() {
    feedbackOperation.current += 1;
    const text = ['# Agent 学习与面试笔记', '', `导出时间：${new Date().toISOString()}`, '', '自评由学习者填写，不代表测试已执行或技能已通过评测。', '', ...learningLessons.flatMap((item, index) => {
      const entry = reflections[item.id];
      return [`## ${index + 1}. ${item.title}`, '', `学习目标：${item.goal}`, '', `自评：${entry?.assessment ?? assessments[0]}`, '', `面试问题：${item.question}`, '', '### 我的回答与实验观察', '', entry?.notes || '（尚未记录）', '', '### 源码定位', '', ...item.sources.map(source => `- ${source.file} — ${source.symbol}`), '', '### 复现命令', '', '```sh', item.command, '```', '', `边界：${item.boundary}`, ''];
    })].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'agent-learning-notes.md';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('已导出 6 课的自评、笔记与复现命令。');
  }

  return <div className="agent-learning">
    <aside className="learning-syllabus" aria-label="学习路径">
      <div className="learning-path-intro"><span className="as-guide-eyebrow">沿一轮问答学习</span><h2>六课，一条真实调用链</h2><p>先读实现，再做实验，最后用自己的话回答。</p></div>
      <nav aria-label="课程目录"><ol>{learningLessons.map((item, index) => <li key={item.id}><button aria-pressed={index === selected} aria-controls="learning-lesson" onClick={() => moveTo(index)}><span className="learning-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{item.topic}</small></span>{reflections[item.id]?.assessment && reflections[item.id].assessment !== assessments[0] && <Check className="learning-assessed" size={14} aria-label="已自评" />}</button></li>)}</ol></nav>
      <div className="learning-notebook"><p><strong>{assessed} / {learningLessons.length}</strong> 课已自评<span>自评不代表已通过测试</span></p><Button onClick={downloadNotes}><Download size={14} aria-hidden="true" />导出学习笔记</Button><p className="learning-memory-note">笔记仅留在当前学习视图。切换上方视图、离开页面或刷新后会丢失，请及时导出。</p></div>
    </aside>

    <article id="learning-lesson" className="learning-lesson" aria-labelledby="learning-title">
      <header className="learning-lesson-header"><span className="as-guide-eyebrow">第 {selected + 1} 课 / {learningLessons.length} · {lesson.topic}</span><h2 id="learning-title" ref={heading} tabIndex={-1}>{lesson.title}</h2><p>{lesson.goal}</p></header>
      <section className="learning-principle" aria-labelledby="learning-principle-title"><h3 id="learning-principle-title">核心原理</h3><p>{lesson.principle}</p><ol className="learning-chain" aria-label="本课关键路径">{lesson.chain.map((step, index) => <li key={step}><code>{step}</code>{index < lesson.chain.length - 1 && <ArrowRight size={13} aria-hidden="true" />}</li>)}</ol></section>
      <section className="learning-section" aria-labelledby="learning-source-title"><div className="learning-section-label"><FileCode2 size={16} aria-hidden="true" /><h3 id="learning-source-title">到源码里找依据</h3></div><p className="learning-hint">以下为仓库内路径，可在编辑器按文件与函数定位。</p><dl className="learning-sources">{lesson.sources.map(source => <div key={`${source.file}:${source.symbol}`}><dt><code>{source.file}</code><span>{source.symbol}</span></dt><dd>{source.readFor}</dd></div>)}</dl></section>
      <section className="learning-section" aria-labelledby="learning-experiment-title"><div className="learning-section-label"><span className="learning-section-mark" aria-hidden="true">$</span><h3 id="learning-experiment-title">做一次可复现实验</h3></div><p className="learning-hint">在仓库根目录运行；先准备 Node ≥ 22.16、Python 3.12、uv，并完成「开发与边界」中的依赖安装与 SDK 探针。</p><div className="learning-command"><pre tabIndex={0} aria-label="本课实验命令"><code>{lesson.command}</code></pre><Button onClick={() => void copyCommand()}><Copy size={13} aria-hidden="true" />复制命令</Button></div><p className="learning-fixture-note">这些命令使用本地测试数据；页面只提供命令，不会执行测试、调用模型或操作业务工具。</p><h4>预期观察</h4><ul className="learning-observations">{lesson.observe.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section className="learning-section learning-interview" aria-labelledby="learning-interview-title"><span className="as-guide-eyebrow">试着口述 90 秒，再展开参考</span><h3 id="learning-interview-title">{lesson.question}</h3><details key={lesson.id}><summary>展开参考回答要点</summary><ol>{lesson.answer.map(item => <li key={item}>{item}</li>)}</ol></details><p className="learning-followup"><strong>继续追问</strong>{lesson.followup}</p><p className="learning-boundary"><strong>回答时守住边界</strong>{lesson.boundary}</p></section>
      <section className="learning-section learning-reflection" aria-labelledby="learning-reflection-title"><div className="learning-reflection-heading"><h3 id="learning-reflection-title">留下自己的回答与实验观察</h3><label htmlFor="learning-assessment">本课自评<select id="learning-assessment" value={reflection.assessment} onChange={event => updateReflection({ assessment: event.target.value })}>{assessments.map(value => <option key={value}>{value}</option>)}</select></label></div><label className="learning-hint" htmlFor="learning-notes">记录你实际运行的结果、还解释不清的地方，以及面试时会用的例子。</label><textarea id="learning-notes" rows={5} maxLength={12000} value={reflection.notes} placeholder="我的解释：…&#10;实验命令与实际结果：…&#10;下一次要补齐：…" onChange={event => updateReflection({ notes: event.target.value })} /><div className="learning-notes-caption"><span>仅当前视图 · 请用左侧按钮导出</span><span>{reflection.notes.length} / 12000</span></div></section>
      <footer className="learning-pagination"><Button disabled={selected === 0} onClick={() => moveTo(selected - 1)}><ArrowLeft size={14} aria-hidden="true" />上一课</Button><span>{selected + 1} / {learningLessons.length}</span><Button primary disabled={selected === learningLessons.length - 1} onClick={() => moveTo(selected + 1)}>下一课<ArrowRight size={14} aria-hidden="true" /></Button></footer>
    </article>
    <p className="learning-feedback" role="status" aria-live="polite">{feedback}</p>
  </div>;
}
