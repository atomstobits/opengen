'use client';

import type { GenerateInput, Operation } from '@media-router/contracts';
import { useState } from 'react';
import styles from './playground-example.module.css';

type Example = {
  title: string;
  settings: string;
  input: GenerateInput['input'] & { prompt: string };
  reference: { src: string; alt: string; role: string };
  result?: { src: string; description: string };
  source: { label: string; url: string };
  notes: string;
};

const cookbookRevision = 'd310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4';
const gptSource = `https://github.com/openai/openai-cookbook/blob/${cookbookRevision}/examples/multimodal/image-gen-models-prompting-guide.ipynb`;
const billboardInput = `https://raw.githubusercontent.com/openai/openai-cookbook/${cookbookRevision}/images/output_images/billboard_gpt-image-2.png`;
const winterPrompt = 'Make it look like a winter evening with snowfall.';
const wanPrompt =
  'Gently move the camera toward the billboard while the surrounding trees sway in a light breeze. Preserve the image composition and billboard lettering.';

const examples: Partial<Record<`${string}:${Operation}`, Example>> = {
  'openai/gpt-image-2:image-edit': {
    title: 'Change the season in a billboard scene',
    settings: '1024 × 1536 · Medium quality · 1 PNG',
    input: {
      prompt: winterPrompt,
      references: [{ type: 'image', asset: { url: billboardInput } }],
      size: { width: 1024, height: 1536 },
      quality: 'medium',
      count: 1,
      outputFormat: 'png',
    },
    reference: {
      src: '/playground-examples/billboard-sunset.webp',
      alt: 'A roadside shampoo billboard in warm sunset light',
      role: 'Input image',
    },
    result: {
      src: '/playground-examples/billboard-winter.webp',
      description: 'The same roadside billboard on a snowy winter evening',
    },
    source: { label: 'OpenAI Cookbook', url: gptSource },
    notes:
      'This edit uses the original cookbook prompt and reference. The images shown are resized previews.',
  },
  'alibaba/wan-3.0:image-to-video': {
    title: 'Animate a roadside billboard scene',
    settings: '480p · 2 seconds · 1 video',
    input: {
      prompt: wanPrompt,
      firstFrame: { url: billboardInput },
      duration: 2,
      resolution: '480p',
      count: 1,
    },
    reference: {
      src: '/playground-examples/billboard-sunset.webp',
      alt: 'A roadside shampoo billboard in warm sunset light',
      role: 'First frame',
    },
    source: { label: 'OpenAI Cookbook reference image', url: gptSource },
    notes:
      'An original OpenGen prompt with an MIT-licensed reference image. Use this sample input to prepare your own generation.',
  },
};

export function PlaygroundExample({
  modelId,
  operation,
  onLoad,
}: {
  modelId: string;
  operation: Operation;
  onLoad: (input: GenerateInput['input']) => void;
}) {
  const example = examples[`${modelId}:${operation}`];
  if (!example) return null;
  return <ExampleDisclosure key={`${modelId}:${operation}`} example={example} onLoad={onLoad} />;
}

function ExampleDisclosure({
  example,
  onLoad,
}: {
  example: Example;
  onLoad: (input: GenerateInput['input']) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details className={styles.example} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{example.result ? 'Public example' : 'Input example'}</span> {example.title}
      </summary>
      {open && (
        <div className={styles.body}>
          <div className={styles.media}>
            <figure>
              <figcaption>{example.reference.role}</figcaption>
              <img
                src={example.reference.src}
                alt={example.reference.alt}
                width="600"
                height="900"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </figure>
            {example.result && (
              <figure>
                <figcaption>Published result</figcaption>
                <img
                  src={example.result.src}
                  alt={example.result.description}
                  width="600"
                  height="900"
                  loading="lazy"
                />
              </figure>
            )}
          </div>
          <p className={styles.settings}>{example.settings}</p>
          <p className={styles.prompt}>{example.input.prompt}</p>
          <p className={styles.source}>
            {example.notes} <a href={example.source.url}>{example.source.label}</a>
          </p>
          <div className={styles.action}>
            <button
              type="button"
              className="button button-outline"
              onClick={() => onLoad(structuredClone(example.input))}
            >
              Use example in draft
            </button>
            <p>
              Replaces your inputs for this operation. You can review and quote before generating.
            </p>
          </div>
        </div>
      )}
    </details>
  );
}
