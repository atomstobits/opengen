'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

/** One finished comparison clip. Splits, input context and model labels belong in the edit. */
export function HeroMedia({
  videoUrl,
  posterUrl = '/hero-poster.png',
}: {
  videoUrl?: string;
  posterUrl?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    const update = () => setEnabled(!preference.matches && !connection?.saveData);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!enabled || !videoUrl || !video.current || !container.current) return;
    const player = video.current;
    let visible = true;
    const update = () => {
      if (visible && document.visibilityState === 'visible') void player.play().catch(() => {});
      else player.pause();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(container.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      player.pause();
    };
  }, [enabled, videoUrl]);
  return (
    <div className="hero-media" ref={container} aria-hidden="true">
      {posterUrl.startsWith('/') ? (
        <Image src={posterUrl} alt="" fill priority sizes="100vw" quality={85} />
      ) : (
        <img src={posterUrl} alt="" />
      )}
      {enabled && videoUrl && (
        <video ref={video} src={videoUrl} muted loop playsInline preload="metadata" tabIndex={-1} />
      )}
      <div className="hero-scrim" />
    </div>
  );
}
