'use client';

import { useEffect, useRef } from 'react';

/* Guilloché: the lathe-turned line work that protects banknotes and share certificates.
   Used once, quietly, behind the closing section. */
const TAU = Math.PI * 2;

export default function Guilloche() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const x = c?.getContext('2d');
    if (!c || !x) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, last = performance.now(), t = 0, visible = false, drawn = false;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(c);

    const band = (cx: number, cy: number, r0: number, amp: number, n: number, K: number, ph: number, col: string, m = 0, ph2 = 0) => {
      x.strokeStyle = col;
      for (let k = 0; k < K; k++) {
        const o = (k / K) * TAU;
        x.beginPath();
        for (let i = 0; i <= 480; i++) {
          const th = (i / 480) * TAU;
          const r = r0 + amp * Math.sin(n * th + o + ph) * (m ? 0.55 + 0.45 * Math.cos(m * th + ph2) : 1);
          const X = cx + r * Math.cos(th), Y = cy + r * Math.sin(th);
          if (i) x.lineTo(X, Y); else x.moveTo(X, Y);
        }
        x.stroke();
      }
    };

    const draw = () => {
      const rect = c.getBoundingClientRect();
      const d = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(rect.width * d), H = Math.round(rect.height * d);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      x.setTransform(d, 0, 0, d, 0, 0);
      x.clearRect(0, 0, rect.width, rect.height);
      const w = rect.width, h = rect.height, cx = w / 2, cy = h / 2, R = Math.min(w * 0.6, h * 0.92, 520);
      x.lineWidth = 0.7;
      band(cx, cy, R * 1.0, R * 0.085, 40, 9, t * 0.1, 'rgba(142,153,171,.26)');
      band(cx, cy, R * 0.74, R * 0.17, 12, 14, -t * 0.08, 'rgba(142,153,171,.2)', 5, t * 0.06);
      band(cx, cy, R * 0.4, R * 0.13, 8, 10, t * 0.13, 'rgba(217,178,106,.3)', 3, -t * 0.05);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      if (reduce && drawn) return;
      t += dt;
      draw();
      drawn = true;
    };
    raf = requestAnimationFrame(frame);
    const onResize = () => { drawn = false; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener('resize', onResize); };
  }, []);

  return <canvas ref={ref} className="guilloche" aria-hidden="true" />;
}
