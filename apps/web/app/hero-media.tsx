'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import type { HeroComparisonItem } from './hero-comparisons';

type NavigatorConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

function useHeroVideoAllowed({ skipNarrowMobile = false }: { skipNarrowMobile?: boolean } = {}) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const narrowMobile = skipNarrowMobile ? matchMedia('(max-width: 620px)') : null;
    const connection = (navigator as Navigator & { connection?: NavigatorConnection }).connection;

    const update = () => {
      const slowConnection =
        connection?.saveData === true ||
        connection?.effectiveType === 'slow-2g' ||
        connection?.effectiveType === '2g';
      const isNarrow = narrowMobile ? narrowMobile.matches : false;
      setEnabled(!reducedMotion.matches && !slowConnection && !isNarrow);
    };

    update();
    reducedMotion.addEventListener('change', update);
    narrowMobile?.addEventListener('change', update);
    return () => {
      reducedMotion.removeEventListener('change', update);
      narrowMobile?.removeEventListener('change', update);
    };
  }, [skipNarrowMobile]);

  return enabled;
}

/** Legacy single-clip fallback when comparison manifest is not configured. */
export function HeroMedia({
  videoUrl,
  posterUrl = '/hero-poster.png',
}: {
  videoUrl?: string;
  posterUrl?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const enabled = useHeroVideoAllowed();

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
        <img src={posterUrl} alt="" fetchPriority="high" decoding="sync" />
      )}
      {enabled && videoUrl && (
        <video ref={video} src={videoUrl} muted loop playsInline preload="metadata" tabIndex={-1} />
      )}
      <div className="hero-scrim" />
    </div>
  );
}

/**
 * Single-stream 50/50 split comparison background player optimized for LCP and SEO:
 * - Immediate static AVIF/WebP poster rendered in SSR HTML (~25-45 KB LCP, zero CLS)
 * - Single muted AV1 + H.264 split stream mounted only after hydration on capable connections
 * - Never preloads the full sequence up front; prefetches only the next poster once playing
 * - Auto-pauses when offscreen, tab-hidden, or while the comparison modal is open
 */
export function HeroSplitMedia({
  clip,
  nextClip,
  paused,
  loopSingle,
  onEnded,
  onProgress,
}: {
  clip: HeroComparisonItem;
  nextClip?: HeroComparisonItem;
  paused: boolean;
  loopSingle: boolean;
  onEnded: () => void;
  onProgress: (percent: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [readyClipId, setReadyClipId] = useState<string | null>(null);
  const [avifFailedClipId, setAvifFailedClipId] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const prefetchedPosters = useRef(new Set<string>());
  const enabled = useHeroVideoAllowed({ skipNarrowMobile: true });

  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry?.isIntersecting ?? false);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled || !video.current) return;
    const player = video.current;

    const syncPlayback = () => {
      if (isVisible && !paused && document.visibilityState === 'visible') {
        void player.play().catch(() => {});
      } else {
        player.pause();
      }
    };

    syncPlayback();
    document.addEventListener('visibilitychange', syncPlayback);
    return () => {
      document.removeEventListener('visibilitychange', syncPlayback);
      player.pause();
    };
  }, [enabled, clip.id, isVisible, paused]);

  const handlePlaying = () => {
    setReadyClipId(clip.id);
    // Warm only the next clip's lightweight poster image after the current clip is playing.
    if (nextClip && !prefetchedPosters.current.has(nextClip.media.heroPosterWebp)) {
      prefetchedPosters.current.add(nextClip.media.heroPosterWebp);
      const preload = new window.Image();
      preload.src = nextClip.media.heroPosterWebp;
    }
  };

  const handleTimeUpdate = () => {
    const player = video.current;
    if (!player) return;
    const duration =
      Number.isFinite(player.duration) && player.duration > 0
        ? player.duration
        : clip.heroDurationSec;
    onProgress(Math.min(100, (player.currentTime / duration) * 100));
  };

  const isVideoReady = readyClipId === clip.id;
  const showAvifSource = Boolean(clip.media.heroPosterAvif) && avifFailedClipId !== clip.id;

  return (
    <div className="hero-media hero-media-split" ref={container} aria-hidden="true">
      <picture className="hero-split-poster" key={`${clip.id}-${showAvifSource ? 'avif' : 'webp'}`}>
        {showAvifSource && clip.media.heroPosterAvif && (
          <source srcSet={clip.media.heroPosterAvif} type="image/avif" />
        )}
        <img
          src={clip.media.heroPosterWebp}
          alt=""
          fetchPriority="high"
          decoding="sync"
          onError={() => {
            if (showAvifSource) setAvifFailedClipId(clip.id);
          }}
        />
      </picture>
      {enabled && (
        <video
          key={clip.id}
          ref={video}
          className={isVideoReady ? 'hero-split-video is-ready' : 'hero-split-video'}
          muted
          loop={loopSingle}
          playsInline
          preload="metadata"
          tabIndex={-1}
          onCanPlay={() => setReadyClipId(clip.id)}
          onPlaying={handlePlaying}
          onTimeUpdate={handleTimeUpdate}
          onEnded={loopSingle ? undefined : onEnded}
        >
          {clip.media.heroVideoAv1 && (
            <source src={clip.media.heroVideoAv1} type='video/mp4; codecs="av01.0.04M.08"' />
          )}
          <source src={clip.media.heroVideoH264} type="video/mp4" />
        </video>
      )}
      <div className="hero-split-divider" />
      <div className="hero-scrim" />
    </div>
  );
}
