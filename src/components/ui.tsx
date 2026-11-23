import { memo, useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Inbox, X } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function Button({ primary = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button {...props} className={`button ${primary ? 'primary' : ''} ${props.className || ''}`}>{children}</button>;
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Empty({ text = '暂无数据' }: { text?: string }) { return <div className="empty"><Inbox size={34} strokeWidth={1.8} /><span>{text}</span></div>; }
export const Markdown = memo(function Markdown({ text }: { text: string }) { return <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text) as string) }} />; });
export function Modal({ title, onClose, children, wide = false, drawer = false, className = '', overlayClassName = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; drawer?: boolean; className?: string; overlayClassName?: string }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]') || []).filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden],[inert]') || !element.getClientRects().length) return false;
      const visibility = window.getComputedStyle(element).visibility;
      if (visibility === 'hidden' || visibility === 'collapse') return false;
      // Closed details keep their descendants in the DOM, but only their first summary is tabbable.
      for (let ancestor = element.parentElement; ancestor && ancestor !== ref.current; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
      }
      return true;
    });
    focusable()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const list = focusable(); const first = list[0]; const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className={`modal-overlay ${drawer ? 'drawer-overlay' : ''} ${overlayClassName}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} className={`modal ${wide ? 'wide-modal' : ''} ${drawer ? 'drawer' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={18} /></button></div>{children}</section></div>;
}
