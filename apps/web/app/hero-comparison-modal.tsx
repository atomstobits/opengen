'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HeroComparisonItem, HeroModelPricing } from './hero-comparisons';
import { playgroundHref } from './links';
import { CopyButton, Icon } from './ui';

type AgentGuide = {
  readonly slug: string;
  readonly name: string;
};

type AudioChannel = 'mute' | 'left' | 'right';

function ModelPriceChip({ model, side }: { model: HeroModelPricing; side: 'left' | 'right' }) {
  return (
    <div className="hero-modal-video-bar">
      <a className="hero-modal-model-link" href={model.seriesHref} title={model.priceNote}>
        <span className={`hero-model-dot is-${side}`} aria-hidden="true" />
        <span>{model.modelName}</span>
        {model.providerName && <small>({model.providerName})</small>}
      </a>
      {model.priceLabel && (
        <span className="hero-price-group" title={model.priceNote}>
          <span className="hero-price-current">{model.priceLabel}</span>
          {model.comparePriceLabel && (
            <span className="hero-price-compare">{model.comparePriceLabel}</span>
          )}
          {model.discountLabel && (
            <span className="hero-price-discount">{model.discountLabel}</span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Lazy comparison modal: mounted only when opened so 0 bytes of modal video or
 * full-size reference images download during initial homepage load.
 */
export function HeroComparisonModal({
  clip,
  agentPrompt,
  agentGuides,
  onClose,
}: {
  clip: HeroComparisonItem;
  agentPrompt: string;
  agentGuides: readonly AgentGuide[];
  onClose: () => void;
}) {
  const [audio, setAudio] = useState<AudioChannel>('mute');
  const leftVideo = useRef<HTMLVideoElement>(null);
  const rightVideo = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const lv = leftVideo.current;
    const rv = rightVideo.current;
    if (lv) lv.muted = audio !== 'left';
    if (rv) rv.muted = audio !== 'right';
  }, [audio]);

  useEffect(() => {
    const lv = leftVideo.current;
    const rv = rightVideo.current;
    if (!lv || !rv) return;
    lv.currentTime = 0;
    rv.currentTime = 0;
    void lv.play().catch(() => {});
    void rv.play().catch(() => {});

    const syncRight = () => {
      if (!lv.paused && Math.abs(lv.currentTime - rv.currentTime) > 0.25) {
        rv.currentTime = lv.currentTime;
      }
    };
    lv.addEventListener('timeupdate', syncRight);
    return () => {
      lv.removeEventListener('timeupdate', syncRight);
      lv.pause();
      rv.pause();
    };
  }, [clip.id]);

  const cycleAudio = () => {
    setAudio((prev) => (prev === 'mute' ? 'left' : prev === 'left' ? 'right' : 'mute'));
  };

  const audioLabel =
    audio === 'mute'
      ? 'Audio: Muted'
      : audio === 'left'
        ? `Audio: ${clip.left.modelName}`
        : `Audio: ${clip.right.modelName}`;

  const browserHref = playgroundHref(clip.left.modelId, undefined, clip.operation);

  const modalContent = (
    <div
      className="modal-backdrop hero-comparison-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="hero-comparison-modal-title"
        className="hero-comparison-modal"
      >
        <div className="hero-modal-head">
          <div className="hero-modal-title-group">
            <h2 id="hero-comparison-modal-title">Shared Input</h2>
            <span className="hero-modal-spec">
              {clip.resolution} · {clip.durationSec}s · {clip.fullPrompt.length.toLocaleString()}{' '}
              chars
            </span>
          </div>
          <div className="hero-modal-head-actions">
            <button type="button" className="hero-modal-chip-btn" onClick={cycleAudio}>
              {audioLabel}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="hero-modal-chip-btn"
              onClick={onClose}
              aria-label="Close comparison"
            >
              Close <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        <div className="hero-modal-section">
          <div className="hero-modal-videos">
            <div className="hero-modal-video-card">
              <ModelPriceChip model={clip.left} side="left" />
              <div className="hero-modal-video-stage">
                <video
                  ref={leftVideo}
                  key={clip.media.modalLeftVideo}
                  src={clip.media.modalLeftVideo}
                  poster={clip.media.modalLeftPoster}
                  controls
                  muted={audio !== 'left'}
                  loop
                  playsInline
                  preload="auto"
                />
              </div>
            </div>
            <div className="hero-modal-video-card">
              <ModelPriceChip model={clip.right} side="right" />
              <div className="hero-modal-video-stage">
                <video
                  ref={rightVideo}
                  key={clip.media.modalRightVideo}
                  src={clip.media.modalRightVideo}
                  poster={clip.media.modalRightPoster}
                  controls
                  muted={audio !== 'right'}
                  loop
                  playsInline
                  preload="auto"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="hero-modal-section">
          <div className="hero-modal-input-head">
            <span className="eyebrow">
              EXACT SHARED INPUT ({clip.inputRole.toUpperCase()} + PROMPT)
            </span>
            <CopyButton text={clip.fullPrompt} label="Copy prompt" />
          </div>
          <div className="hero-modal-input-grid">
            <img
              src={clip.media.inputImageWebp}
              alt={`Shared input image for ${clip.left.modelName} and ${clip.right.modelName}`}
              decoding="async"
            />
            <pre className="hero-modal-prompt">{clip.fullPrompt}</pre>
          </div>
        </div>

        <div className="hero-modal-actions">
          <div className="hero-modal-agent-card">
            <div className="hero-modal-agent-top">
              <span>Connect your agent</span>
              <div className="hero-agent-icons">
                {agentGuides.map(({ slug, name }) => (
                  <a
                    key={slug}
                    href={`/agents/${slug}`}
                    aria-label={`${name} setup guide`}
                    title={name}
                  >
                    <img src={`/agent-icons/${slug}.svg`} alt="" width={17} height={17} />
                  </a>
                ))}
              </div>
            </div>
            <div className="hero-modal-agent-cmd">
              <span aria-hidden="true">$</span>
              <code>{agentPrompt}</code>
              <CopyButton text={agentPrompt} label="Copy" />
            </div>
          </div>

          <div className="hero-modal-cta-row">
            <div className="hero-modal-dev-links">
              <a className="button button-outline button-sm" href="/agents/cli">
                <span aria-hidden="true">&gt;_</span> CLI setup
              </a>
              <a className="button button-outline button-sm" href="/docs#http-examples">
                <span aria-hidden="true">&lt;/&gt;</span> API setup
              </a>
            </div>
            <a className="button button-dark" href={browserHref}>
              Continue in browser <Icon name="arrow" size={16} />
            </a>
          </div>
        </div>
      </section>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modalContent, document.body);
}
