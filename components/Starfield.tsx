'use client';

import { useEffect, useRef } from 'react';
import { useReducedMotion } from '@/lib/useReducedMotion';
import styles from './Starfield.module.css';

type Star = { x: number; y: number; z: number; r: number; tw: number };

/**
 * Ambient drift behind the hero. Earned by the name, and kept quiet enough
 * that it never competes with the diagram sitting on top of it: no star is
 * brighter than the body text, and the whole layer fades out toward the
 * bottom edge so the section boundary stays crisp.
 */
export default function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let stars: Star[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    const seed = () => {
      const density = Math.round((w * h) / 9000);
      const count = Math.max(40, Math.min(260, density));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.25 + Math.random() * 0.75,
        r: 0.4 + Math.random() * 1.15,
        tw: Math.random() * Math.PI * 2,
      }));
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      const ratio = dpr();
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      seed();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        // Parallax: nearer stars drift faster. Slow enough to read as
        // depth rather than as movement.
        if (!reduced) s.x -= s.z * 0.05;
        if (s.x < -2) s.x = w + 2;

        const twinkle = reduced ? 0.6 : 0.55 + 0.45 * Math.sin(t / 1400 + s.tw);
        ctx.globalAlpha = 0.1 + s.z * 0.34 * twinkle;
        ctx.fillStyle = s.z > 0.82 ? '#b9a9ff' : '#e3dff5';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * s.z, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    };

    resize();
    draw(0);

    const ro = new ResizeObserver(() => {
      resize();
      if (reduced) draw(0);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reduced]);

  return (
    <div className={styles.wrap} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
      <div className={styles.glow} />
    </div>
  );
}
