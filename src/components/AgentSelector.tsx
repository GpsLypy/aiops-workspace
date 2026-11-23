import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Layers, Check, ChevronDown, LockKeyhole } from 'lucide-react';
import type { Resource } from '../api';

export default function AgentSelector({ resources, value, onChange, locked, busy }: {
  resources: Resource[]; value: string; onChange: (id: string) => void; locked: boolean; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 420 });
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const agents = resources.filter(r => r.kind === 'agents' && r.status === '已启用');
  const selected = resources.find(r => r.kind === 'agents' && r.id === value);
  const unavailable = !!value && !agents.some(r => r.id === value);
  const name = value ? selected?.name || '当前 Agent' : '通用';
  const status = unavailable ? selected ? '已停用' : '不可用' : '';
  const disabled = locked || busy;
  const hint = busy ? '正在生成，暂时不能切换 Agent' : locked ? '当前会话已绑定 Agent，新建会话后可切换' : `${name}${status ? `（${status}）` : ''}，选择用于本次新会话的 Agent`;
  const choices = [{ id: '', name: '通用 Agent', description: '不限子领域，使用通用能力回答。' },
    ...agents.map(r => ({ id: r.id, name: r.name, description: r.description?.trim() || '使用专用指令与已授权工具回答。' }))];
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const focusOption = (index: number) => {
    setActive(index);
    const option = panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index];
    option?.focus(); option?.scrollIntoView({ block: 'nearest' });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), menu = panel.current;
      if (!anchor || !menu) return;
      const above = anchor.top - 20, below = innerHeight - anchor.bottom - 20;
      const up = above >= below;
      const maxHeight = Math.max(64, Math.min(420, up ? above : below));
      const height = Math.min(menu.scrollHeight, maxHeight);
      setPosition({ left: Math.max(12, Math.min(anchor.left, innerWidth - menu.offsetWidth - 12)),
        top: Math.max(12, up ? anchor.top - height - 8 : anchor.bottom + 8), maxHeight });
    };
    place(); focusOption(Math.max(0, choices.findIndex(option => option.id === value)));
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, value, resources]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button ref={trigger} type="button" className={`agent-trigger${unavailable ? ' agent-unavailable' : ''}`} aria-label="Agent" aria-describedby={`${id}-hint`} title={hint}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      <Layers size={14} aria-hidden="true" /><span>{name}{status && <small> · {status}</small>}</span>
      {locked ? <LockKeyhole size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
    </button>
    <span id={`${id}-hint`} className="agent-picker-hint">{hint}</span>
    {open && createPortal(<div className="agent-menu" style={position} ref={panel} onBlur={event => {
      if (!panel.current?.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close();
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Tab') close(true);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
      }
    }}>
      <div className="agent-menu-heading"><strong>选择 Agent</strong><span>用于新会话</span></div>
      <div id={id} role="listbox" aria-label="选择 Agent">
        {choices.map((option, index) => <button type="button" key={option.id} role="option" aria-selected={value === option.id} tabIndex={active === index ? 0 : -1}
          data-agent-id={option.id} className="agent-option" onFocus={() => setActive(index)} onClick={() => { onChange(option.id); close(true); }}>
          <span className="agent-option-icon">{option.id ? <Bot size={18} aria-hidden="true" /> : <Layers size={18} aria-hidden="true" />}</span>
          <span className="agent-option-copy"><strong>{option.name}</strong><span title={option.description}>{option.description}</span></span>
          <span className="agent-option-check">{value === option.id && <Check size={17} aria-hidden="true" />}</span>
        </button>)}
      </div>
    </div>, document.body)}
  </>;
}
