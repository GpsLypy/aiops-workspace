import brandUrl from '../assets/baixiaosheng.svg';

/** Decorative mark: the surrounding text supplies the product or speaker name. */
export default function BrandMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img src={brandUrl} width={size} height={size} className={`brand-icon ${className}`.trim()} alt="" aria-hidden="true" draggable={false} />;
}
