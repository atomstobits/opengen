'use client';

import type { GenerateInput, Operation } from '@media-router/contracts';
import { useState } from 'react';
import styles from './playground-example.module.css';

export type PlaygroundExampleEntry = {
  title: string;
  settings: string;
  input: GenerateInput['input'] & { prompt: string };
  reference?: { src: string; alt: string; role: string };
  result?: { src: string; description: string };
  source?: { label: string; url: string };
  notes: string;
};

const cookbookRevision = 'd310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4';
const gptSource = `https://github.com/openai/openai-cookbook/blob/${cookbookRevision}/examples/multimodal/image-gen-models-prompting-guide.ipynb`;
const billboardInput = `https://raw.githubusercontent.com/openai/openai-cookbook/${cookbookRevision}/images/output_images/billboard_gpt-image-2.png`;
const winterPrompt = 'Make it look like a winter evening with snowfall.';
const wanPrompt =
  'Gently move the camera toward the billboard while the surrounding trees sway in a light breeze. Preserve the image composition and billboard lettering.';

export const playgroundExamples: Partial<Record<`${string}:${Operation}`, PlaygroundExampleEntry>> =
  {
    'openai/gpt-image-2:text-to-image': {
      title: 'Architectural stoneware studio still life',
      settings: '1K · Low quality · 1:1 · 1 PNG',
      input: {
        prompt:
          'Hand-thrown matte stoneware teapot resting on a travertine plinth in morning window light, crisp shadows, medium-format editorial studio photography.',
        resolution: '1K',
        aspectRatio: '1:1',
        quality: 'low',
        count: 1,
        outputFormat: 'png',
      },
      notes:
        'An original OpenGen starter prompt sized to the low-cost 1K PNG configuration. Loading it prepares your draft without quoting or spending credit.',
    },
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
    'bytedance/seedream-5.0-pro:text-to-image': {
      title: 'Sunlit glass botanical conservatory',
      settings: '1K · 4:3 · 1 image',
      input: {
        prompt:
          'Sunlit glass botanical conservatory filled with architectural palms and warm limestone walkways, clean natural daylight, medium-format architectural photography.',
        resolution: '1K',
        aspectRatio: '4:3',
        count: 1,
      },
      notes:
        'An original OpenGen starter prompt for Seedream 5.0 Pro at 1K resolution. No preview image is fabricated; load the settings and quote before generating.',
    },
    'bytedance/seedance-2.5:text-to-video': {
      title: 'Misty coastal cliff road at sunrise',
      settings: '720p · 5 seconds · 16:9 · Audio on',
      input: {
        prompt:
          'Slow cinematic tracking shot along a misty coastal cliff road at sunrise as ocean waves break below and warm light clears the morning fog.',
        resolution: '720p',
        duration: 5,
        aspectRatio: '16:9',
        audio: true,
        count: 1,
      },
      notes:
        'An original OpenGen starter prompt for Seedance 2.5. No preview clip is fabricated; load the settings and quote before generating.',
    },
    'kling/kling-4.0:text-to-video': {
      title: 'Lantern-lit stone alley after rain',
      settings: '720p · 5 seconds · 16:9 · Native audio',
      input: {
        prompt:
          'Steady cinematic dolly through a quiet lantern-lit stone alley just after rain, warm reflections shimmering across wet cobblestones with soft ambient rain.',
        resolution: '720p',
        duration: 5,
        aspectRatio: '16:9',
        count: 1,
      },
      notes:
        'An original OpenGen starter prompt for Kling 4.0 at 720p. No preview clip is fabricated; load the settings and quote before generating.',
    },
    'alibaba/wan-3.0:text-to-video': {
      title: 'Morning espresso pour in macro light',
      settings: '480p · 2 seconds · 16:9 · 1 video',
      input: {
        prompt:
          'Close-up macro shot of rich espresso pouring into a warm stoneware cup in soft morning cafe light, delicate crema forming and steam rising slowly.',
        resolution: '480p',
        duration: 2,
        aspectRatio: '16:9',
        count: 1,
      },
      notes:
        'An original OpenGen starter prompt using the compact 480p 2-second configuration. No preview clip is fabricated; load the settings and quote before generating.',
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
  const example = playgroundExamples[`${modelId}:${operation}`];
  if (!example) return null;
  return <ExampleDisclosure key={`${modelId}:${operation}`} example={example} onLoad={onLoad} />;
}

function ExampleDisclosure({
  example,
  onLoad,
}: {
  example: PlaygroundExampleEntry;
  onLoad: (input: GenerateInput['input']) => void;
}) {
  const [open, setOpen] = useState(false);
  const badge = example.result
    ? 'Public example'
    : example.reference
      ? 'Input example'
      : 'Starter example';

  return (
    <details className={styles.example} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{badge}</span> {example.title}
      </summary>
      {open && (
        <div className={styles.body}>
          {(example.reference || example.result) && (
            <div className={styles.media}>
              {example.reference && (
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
              )}
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
          )}
          <p className={styles.settings}>{example.settings}</p>
          <p className={styles.prompt}>{example.input.prompt}</p>
          <p className={styles.source}>
            {example.notes}
            {example.source && (
              <>
                {' '}
                <a href={example.source.url}>{example.source.label}</a>
              </>
            )}
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
