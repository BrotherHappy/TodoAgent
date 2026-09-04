// Adapted from DesktopBuddy ScreenRegionSelector, MIT (DCDingCong).
import { useEffect, useRef, useState } from 'react';
import type { ScreenRegion } from '../../shared/agent-context';
export function ScreenRegionSelector() {
  const root = useRef<HTMLElement>(null);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const [rect, setRect] = useState<ScreenRegion>();
  useEffect(() => {
    document.body.classList.add('buddy-screen-selecting');
    document.documentElement.classList.add('buddy-screen-selecting');
    root.current?.focus();
    return () => { document.body.classList.remove('buddy-screen-selecting'); document.documentElement.classList.remove('buddy-screen-selecting'); };
  }, []);
  const calculate = (x: number, y: number): ScreenRegion | undefined => start.current ? { x: Math.min(x, start.current.x), y: Math.min(y, start.current.y), width: Math.abs(x - start.current.x), height: Math.abs(y - start.current.y) } : undefined;
  return <main ref={root} className="buddy-screen-selector" tabIndex={0} aria-label="拖动选择屏幕区域，Esc 取消"
    onPointerDown={event => { start.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => setRect(calculate(event.clientX, event.clientY))}
    onPointerUp={event => { const region = calculate(event.clientX, event.clientY); void window.desktopApi?.agentContext?.finishScreenRegion(region && region.width >= 24 && region.height >= 24 ? region : null); }}
    onKeyDown={event => { if (event.key === 'Escape') void window.desktopApi?.agentContext?.finishScreenRegion(null); }}>
    <div className="buddy-screen-hint">拖动框选 · 松开后预览 · Esc 取消（尚未发送给模型）</div>
    {rect && <div className="buddy-screen-box" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />}
  </main>;
}
