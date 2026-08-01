'use client';

import { animate, stagger } from 'animejs';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * anime.js micro-interactions, kept deliberately small: entrance staggers and
 * number count-ups only, 150–400ms, transform/opacity-only, and disabled
 * entirely under prefers-reduced-motion.
 */

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Staggers direct children in on mount (and again when `signal` changes). */
export function Stagger({
  children,
  className,
  signal,
}: {
  children: ReactNode;
  className?: string;
  signal?: string | number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const items = Array.from(el.children) as HTMLElement[];
    if (items.length === 0) return;
    animate(items, {
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 340,
      delay: stagger(45),
      ease: 'out(3)',
    });
  }, [signal]);
  return (
    <div ref={ref} className={className} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

/** Animates a numeric value up from 0 whenever it changes. */
export function CountUp({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (v: number) => `${prefix}${Math.round(v).toLocaleString()}${suffix}`;
    if (reducedMotion()) {
      el.textContent = fmt(value);
      prev.current = value;
      return;
    }
    const counter = { v: prev.current };
    animate(counter, {
      v: value,
      duration: 700,
      ease: 'out(4)',
      onUpdate: () => {
        el.textContent = fmt(counter.v);
      },
    });
    prev.current = value;
  }, [value, prefix, suffix]);
  return <span ref={ref}>{`${prefix}${value.toLocaleString()}${suffix}`}</span>;
}
