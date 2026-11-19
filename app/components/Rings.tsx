'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/* The hero mechanism. Five rotating rings, one per check the vault contract runs.
   Transfers leave the centre and either pass every ring or stop at the one that rejects them.
   Everything here is a visual simulation. It never touches a wallet or the chain. */

export type Verdict = { id: number; amount: string; to: string; lock: number }; // lock -1 = sent, 0..4 = stopped at that ring
export type RingsHandle = { fire: (lock: number, amount: string, to: string) => void };

type Pulse = { id: number; a: number; r: number; k: number; f: number; s: 0 | 1 | 2; life: number; amount: string; to: string };
type Flash = { k: number; a: number; life: number };

const TAU = Math.PI * 2;
const LABELS = ['REGISTERED AGENT', 'NOT PAUSED', 'APPROVED RECIPIENT', 'PER-TRANSACTION LIMIT', 'DAILY LIMIT'];
const APPROVED = ['0x41…9b', '0x8c…07', '0xd3…5e'];
const STRANGERS = ['0x9f…e2', '0x17…aa'];
const ringR = (i: number) => 0.26 + 0.185 * i;
const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);
let seq = 100;

function ambientPulse(): Pulse {
  let f = -1;
  if (Math.random() > 0.55) {
    const r = Math.random();
    f = r < 0.08 ? 0 : r < 0.16 ? 1 : r < 0.48 ? 2 : r < 0.76 ? 3 : 4;
  }
  const amount = (f === 3 ? 0.02 + Math.random() * 0.08 : 0.001 + Math.random() * 0.009).toFixed(3);
  const to = f === 2 ? STRANGERS[(Math.random() * STRANGERS.length) | 0] : APPROVED[(Math.random() * APPROVED.length) | 0];
  return { id: seq++, a: Math.random() * TAU, r: 0, k: 0, f, s: 0, life: 1, amount, to };
}

type Props = { highlight: number; onVerdict: (v: Verdict) => void };

const Rings = forwardRef<RingsHandle, Props>(function Rings({ highlight, onVerdict }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const S = useRef({ pulses: [] as Pulse[], flashes: [] as Flash[], heat: [0, 0, 0, 0, 0], t: 0, spin: 0, next: 2.1, px: 0, py: 0, tx: 0, ty: 0 });
  const hl = useRef(highlight);
  hl.current = highlight;
  const cb = useRef(onVerdict);
  cb.current = onVerdict;

  useImperativeHandle(ref, () => ({
    fire(lock, amount, to) {
      // Aim user-fired transfers at the part of the mechanism that is on screen:
      // to the left on wide layouts (the rings bleed off the right edge), upwards on phones.
      const narrow = window.innerWidth <= 860;
      const a = narrow ? -Math.PI / 2 + (Math.random() - 0.5) * 1.3 : Math.PI * (0.62 + Math.random() * 0.76);
      S.current.pulses.push({ id: seq++, a, r: 0, k: 0, f: lock, s: 0, life: 1, amount, to });
    },
  }), []);

  useEffect(() => {
    const c = canvasRef.current;
    const x = c?.getContext('2d');
    if (!c || !x) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const st = S.current;
    if (reduce) st.t = 10;
    let raf = 0;
    let last = performance.now();
    let visible = true;

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(c);
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      st.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      st.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const arcText = (str: string, cx: number, cy: number, r: number, a0: number) => {
      x.save();
      x.translate(cx, cy);
      x.rotate(a0);
      for (let i = 0; i < str.length; i++) {
        const w = x.measureText(str[i]).width + 2.4;
        x.rotate(w / 2 / r);
        x.fillText(str[i], -(w - 2.4) / 2, -r);
        x.rotate(w / 2 / r);
      }
      x.restore();
    };

    const draw = (dt: number) => {
      const rect = c.getBoundingClientRect();
      const d = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(rect.width * d);
      const H = Math.round(rect.height * d);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      x.setTransform(d, 0, 0, d, 0, 0);
      x.clearRect(0, 0, rect.width, rect.height);

      const w = rect.width, h = rect.height;
      const R = Math.min(w, h) * 0.452;
      const bx = w / 2, by = h / 2;
      st.t += dt;
      if (!reduce) st.spin += dt;
      st.px += (st.tx - st.px) * Math.min(1, dt * 3);
      st.py += (st.ty - st.py) * Math.min(1, dt * 3);
      // Parallax: outer rings shift further than inner ones, so the stack reads as depth.
      const ox = (rn: number) => bx - st.px * rn * R * 0.075;
      const oy = (rn: number) => by - st.py * rn * R * 0.075;
      const H_ = hl.current;

      const glow = x.createRadialGradient(bx, by, 0, bx, by, R * 0.6);
      glow.addColorStop(0, 'rgba(190,215,255,.18)');
      glow.addColorStop(1, 'rgba(190,215,255,0)');
      x.fillStyle = glow;
      x.beginPath(); x.arc(bx, by, R * 0.6, 0, TAU); x.fill();

      x.font = `600 ${Math.max(7.5, R * 0.031)}px "Hanken Grotesk", system-ui, sans-serif`;

      for (let i = 0; i < 5; i++) {
        const rn = ringR(i);
        const r = R * rn, cx = ox(rn), cy = oy(rn);
        const p = ease((st.t - 0.15 - i * 0.17) / 1.0); // intro: each ring sweeps closed in turn
        if (p <= 0) continue;
        const rot = st.spin * (0.05 + 0.018 * i) * (i % 2 ? -1 : 1) + i;
        const on = H_ === i;
        const start = -Math.PI / 2 + i;

        x.lineWidth = on ? 1.8 : 1;
        x.strokeStyle = on ? 'rgba(217,178,106,.95)' : 'rgba(142,153,171,.42)';
        if (on) { x.shadowColor = 'rgba(217,178,106,.7)'; x.shadowBlur = 14; }
        x.beginPath(); x.arc(cx, cy, r, start, start + TAU * p); x.stroke();
        x.shadowBlur = 0;

        x.lineWidth = 1;
        x.strokeStyle = `rgba(142,153,171,${0.16 * p})`;
        x.beginPath(); x.arc(cx, cy, r - R * 0.034, 0, TAU); x.stroke();

        const n = 36 + i * 18;
        x.beginPath();
        for (let j = 0; j < n; j++) {
          const a = rot + (j / n) * TAU, l = j % 6 ? 3 : 7, ca = Math.cos(a), sa = Math.sin(a);
          x.moveTo(cx + ca * (r - l), cy + sa * (r - l));
          x.lineTo(cx + ca * r, cy + sa * r);
        }
        x.strokeStyle = `rgba(142,153,171,${0.55 * p})`;
        x.stroke();

        x.strokeStyle = `rgba(238,240,242,${0.6 * p})`;
        x.lineWidth = 2.5;
        for (let j = 0; j < 3; j++) {
          const b = -rot * 1.6 + (j * TAU) / 3 + i;
          x.beginPath(); x.arc(cx, cy, r - R * 0.017, b, b + 0.42); x.stroke();
        }

        if (st.heat[i] > 0) {
          st.heat[i] = Math.max(0, st.heat[i] - dt * 1.2);
          x.strokeStyle = `rgba(255,91,58,${0.55 * st.heat[i]})`;
          x.lineWidth = 1.5;
          x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();
        }

        x.fillStyle = `rgba(217,178,106,${(H_ >= 0 && !on ? 0.45 : 0.95) * p})`;
        arcText(`${i + 1}   ${LABELS[i]}`, cx, cy, r + R * 0.02, rot * 0.6 + i * 1.3);
      }

      if (!reduce && st.t > 1.9) {
        st.next -= dt;
        if (st.next <= 0) { st.pulses.push(ambientPulse()); st.next = 1.1 + Math.random() * 0.9; }
      }

      x.lineCap = 'round';
      for (const p of st.pulses) {
        if (p.s === 0) {
          p.r += dt * 0.4;
          while (p.k < 5 && p.r >= ringR(p.k)) {
            if (p.f === p.k) {
              p.s = 1; p.r = ringR(p.k); p.life = 1; st.heat[p.k] = 1;
              cb.current({ id: p.id, amount: p.amount, to: p.to, lock: p.f });
              break;
            }
            st.flashes.push({ k: p.k, a: p.a, life: 1 });
            p.k++;
          }
          if (p.s === 0 && p.r > 1.1) {
            p.s = 2; p.life = 1;
            cb.current({ id: p.id, amount: p.amount, to: p.to, lock: -1 });
          }
        } else {
          p.life -= dt * (p.s === 1 ? 0.65 : 1.8);
        }
        if (p.life <= 0) continue;
        const ca = Math.cos(p.a), sa = Math.sin(p.a);
        const hx = ox(p.r) + ca * p.r * R, hy = oy(p.r) + sa * p.r * R;
        if (p.s !== 1) {
          const tr = Math.max(0, p.r - 0.17);
          const tx = ox(tr) + ca * tr * R, ty = oy(tr) + sa * tr * R;
          const g = x.createLinearGradient(tx, ty, hx, hy);
          g.addColorStop(0, 'rgba(200,225,255,0)');
          g.addColorStop(1, `rgba(222,236,255,${0.95 * p.life})`);
          x.strokeStyle = g; x.lineWidth = 2;
          x.beginPath(); x.moveTo(tx, ty); x.lineTo(hx, hy); x.stroke();
          x.fillStyle = `rgba(255,255,255,${p.life})`;
          x.beginPath(); x.arc(hx, hy, 2.8, 0, TAU); x.fill();
        } else {
          const e = 1 - p.life;
          x.strokeStyle = `rgba(255,91,58,${p.life})`;
          x.lineWidth = 3.5;
          x.beginPath(); x.arc(ox(p.r), oy(p.r), p.r * R, p.a - 0.24, p.a + 0.24); x.stroke();
          x.lineWidth = 1.5;
          x.beginPath(); x.arc(hx, hy, 5 + e * 28, 0, TAU); x.stroke();
          x.fillStyle = `rgba(255,91,58,${Math.min(1, p.life * 1.6)})`;
          x.beginPath(); x.arc(hx, hy, 4.2, 0, TAU); x.fill();
        }
      }
      st.pulses = st.pulses.filter((p) => p.life > 0);

      for (const f of st.flashes) {
        f.life -= dt * 2.1;
        if (f.life <= 0) continue;
        const rn = ringR(f.k);
        x.strokeStyle = `rgba(222,236,255,${f.life})`;
        x.lineWidth = 3;
        x.beginPath(); x.arc(ox(rn), oy(rn), R * rn, f.a - 0.15, f.a + 0.15); x.stroke();
      }
      st.flashes = st.flashes.filter((f) => f.life > 0);
      x.lineCap = 'butt';

      const core = ease(st.t / 0.6);
      x.fillStyle = '#EEF0F2';
      x.beginPath(); x.arc(bx, by, R * 0.034 * core, 0, TAU); x.fill();
      x.strokeStyle = 'rgba(238,240,242,.45)';
      x.lineWidth = 1;
      x.beginPath(); x.arc(bx, by, R * (0.078 + Math.sin(st.t * 2) * 0.008) * core, 0, TAU); x.stroke();
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      draw(dt);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="rings"
      role="img"
      aria-label="Five rotating rings, one for each check the vault runs. Transfers leave the centre and either pass every ring or stop at the ring that rejects them."
    />
  );
});

export default Rings;
