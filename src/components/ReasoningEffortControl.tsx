import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Zap, Gauge, Lightbulb, Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { ReasoningEffort } from '../api';

export const effortOptions = [
  { value: 'low', label: '快速', description: '优先响应速度', Icon: Zap },
  { value: 'medium', label: '均衡', description: '均衡速度和回答质量', Icon: Gauge },
  { value: 'high', label: '深度', description: '优先分析质量', Icon: Lightbulb },
] as const;

export default function ReasoningEffortControl({ value, defaultEffort, onChange, disabled }: {
  value: ReasoningEffort | null | undefined; defaultEffort: ReasoningEffort | null;
  onChange: (value: ReasoningEffort | null | undefined) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const effective = value === undefined ? defaultEffort : value;
  const selected = effortOptions.find(option => option.value === effective);
  const Icon = selected?.Icon || Gauge;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const choose = (next: typeof value) => { onChange(next); close(true); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const menu = panel.current?.getBoundingClientRect();
      if (anchor && menu) setPosition({
        left: Math.max(12, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 12)),
        top: Math.max(12, Math.min(anchor.top - menu.height - 8, window.innerHeight - menu.height - 12)),
      });
    };
    place();
    (panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') || panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
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
    <button ref={trigger} type="button" className="effort-trigger" aria-label={`问答强度：${selected?.label || '服务商默认'}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(!open)}>
      <Icon size={14} aria-hidden="true" /><span>{selected?.label || '选择强度'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={id} role="menu" aria-label="问答强度" className="effort-menu" style={position} onBlur={event => {
      if (!panel.current?.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close();
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
      <div className="effort-menu-heading"><span>问答强度</span><small>用于接下来的问答</small></div>
      {effortOptions.map(({ value: option, label, description, Icon: OptionIcon }) => <button key={option} type="button" role="menuitemradio" aria-checked={effective === option} className="effort-option" onClick={() => choose(option)}>
        <span className="effort-option-icon"><OptionIcon size={19} aria-hidden="true" /></span>
        <span className="effort-option-copy"><strong>{label}{defaultEffort === option && <small>系统默认</small>}</strong><span>{description}</span></span>
        {effective === option && <Check size={18} className="effort-check" aria-hidden="true" />}
      </button>)}
      <div className="effort-menu-footer"><button type="button" role="menuitem" onClick={() => choose(undefined)}><RotateCcw size={13} aria-hidden="true" />使用系统默认<span>{effortOptions.find(option => option.value === defaultEffort)?.label || '服务商默认'}</span></button>
        {defaultEffort != null && <button type="button" role="menuitem" onClick={() => choose(null)}>使用服务商默认<span>不指定强度</span></button>}
      </div>
    </div>, document.body)}
  </>;
}
