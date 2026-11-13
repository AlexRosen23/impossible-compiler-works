// Renders a validated scene command buffer onto a canvas. Text is drawn with fillText: FOLIO strings never
// reach the DOM as markup. A hidden table gives screen readers the same content.
import { useEffect, useRef } from 'react';
import { DEFAULT_LIMITS, type DrawCmd, type SceneOutput, validateScene } from '../../core/index.ts';

function hexToCss(h: string | null | undefined): string | null {
  if (!h) return null;
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16), a = parseInt(h.slice(7, 9) || 'ff', 16) / 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

export function drawFrame(ctx: CanvasRenderingContext2D, scene: SceneOutput, cmds: DrawCmd[], scale: number) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = hexToCss(scene.background.length === 7 ? scene.background + 'ff' : scene.background) ?? '#101013';
  ctx.fillRect(0, 0, scene.width, scene.height);
  for (const c of cmds) {
    const [a, b, cc, d, e, f] = c.m;
    ctx.setTransform(a * scale, b * scale, cc * scale, d * scale, e * scale, f * scale);
    ctx.globalAlpha = c.o;
    const A = c.a as Record<string, unknown>;
    const fill = hexToCss(A.fill as string | null), stroke = hexToCss(A.stroke as string | null);
    const sw = (A.strokeWidth as number) ?? 1;
    ctx.beginPath();
    switch (c.k) {
      case 'circle': ctx.arc(A.x as number, A.y as number, A.radius as number, 0, Math.PI * 2); break;
      case 'rect': {
        const r = Math.min(A.corner as number, (A.width as number) / 2, (A.height as number) / 2);
        if (r > 0 && ctx.roundRect) ctx.roundRect(A.x as number, A.y as number, A.width as number, A.height as number, r);
        else ctx.rect(A.x as number, A.y as number, A.width as number, A.height as number);
        break;
      }
      case 'line': { const [p] = A.from as number[][]; const [q] = A.to as number[][]; ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); break; }
      case 'path': { const pts = A.points as number[][]; pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); if (A.closed) ctx.closePath(); break; }
      case 'text':
        ctx.font = `${A.size as number}px "Iowan Old Style", Georgia, serif`;
        ctx.fillStyle = fill ?? '#f0eadd';
        ctx.fillText(String(A.value), A.x as number, A.y as number);
        continue;
    }
    if (fill && c.k !== 'line') { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke && sw > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

export function SceneCanvas({ scene, cmds, label, maxCss = 1600 }: { scene: SceneOutput | null; cmds: DrawCmd[] | null; label?: string; maxCss?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const problems = scene ? validateScene({ ...scene, frames: [{ index: 0, time: 0, cmds: cmds ?? [] }] }, DEFAULT_LIMITS) : [];
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !scene || !cmds || problems.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(scene.width, maxCss), s = (w / scene.width) * dpr;
    cv.width = Math.round(scene.width * s); cv.height = Math.round(scene.height * s);
    cv.style.aspectRatio = `${scene.width} / ${scene.height}`;
    cv.style.width = `${w}px`;
    drawFrame(cv.getContext('2d')!, scene, cmds, s);
  });
  if (!scene) return <div className="empty">No scene yet: compile a program.</div>;
  if (problems.length) return <div className="empty">Scene rejected by the renderer's validator: {problems.slice(0, 3).join('; ')}</div>;
  const counts = (cmds ?? []).reduce<Record<string, number>>((m, c) => ((m[c.k] = (m[c.k] ?? 0) + 1), m), {});
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'nothing drawn';
  return (
    <>
      <canvas ref={ref} role="img" aria-label={`${label ?? scene.title}: ${summary}`} />
      <table className="sr-only"><caption>Shapes drawn</caption><tbody>{(cmds ?? []).slice(0, 200).map((c, i) => <tr key={i}><td>{c.k}</td><td>{JSON.stringify(c.a)}</td></tr>)}</tbody></table>
    </>
  );
}
