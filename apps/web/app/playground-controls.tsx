'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  AssetRef,
  GenerationArguments,
  MediaReference,
  Operation,
  Route,
} from '@media-router/contracts';
import { getGenerationDefinition } from '@media-router/contracts/generation';
import { ReferenceUpload, type UploadedReference } from './reference-upload';
import {
  getPlaygroundFields,
  parseStructuredArgument,
  type ArgumentName,
  type PlaygroundField,
} from './playground-fields';
import styles from './playground-controls.module.css';

const labels: Record<ArgumentName, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negative prompt',
  firstFrame: 'First frame',
  lastFrame: 'Last frame',
  sourceVideo: 'Source video',
  mask: 'Mask',
  references: 'References',
  duration: 'Duration',
  resolution: 'Resolution',
  size: 'Exact output size',
  aspectRatio: 'Aspect ratio',
  count: 'Output count',
  quality: 'Quality',
  outputFormat: 'Output format',
  outputCompression: 'Output compression',
  background: 'Background',
  seed: 'Seed',
  audio: 'Generated audio',
  draft: 'Draft mode',
  draftJobId: 'Draft job ID',
  codec: 'Codec',
  bitrateMode: 'Bitrate mode',
  promptExpansion: 'Prompt expansion',
  thinkingLevel: 'Thinking level',
  systemPrompt: 'System prompt',
  grounding: 'Grounding',
  targetAudio: 'Target audio',
  layers: 'Layers',
  strength: 'Edit strength',
  keyframes: 'Keyframes',
  shots: 'Shots',
  elements: 'Elements',
  watermark: 'Watermark',
  promptExtend: 'Extend prompt',
  thinking: 'Thinking',
};
const assets = new Set<ArgumentName>([
  'firstFrame',
  'lastFrame',
  'sourceVideo',
  'mask',
  'targetAudio',
]);
const structured = new Set<ArgumentName>(['size', 'keyframes', 'shots', 'elements']);
const examples: Partial<Record<ArgumentName, unknown>> = {
  size: { width: 1024, height: 1024 },
  keyframes: [{ image: { url: 'https://example.com/frame.png' }, at: 'start' }],
  shots: [{ prompt: 'A slow tracking shot', duration: 5 }],
  elements: [
    {
      id: 'character-1',
      images: [{ assetKey: 'your-ready-input-key' }],
      description: 'Main character',
    },
  ],
};

function AssetEditor({
  label,
  value,
  onChange,
  media,
  authenticated,
  filenames,
  rememberFile,
}: {
  label: string;
  value?: AssetRef;
  onChange: (value: AssetRef | undefined) => void;
  media: 'image' | 'video' | 'audio' | 'document';
  authenticated: boolean;
  filenames: Record<string, string>;
  rememberFile: (file: UploadedReference) => void;
}) {
  const mode = value && 'assetKey' in value ? 'owned' : 'url';
  const id = useId();
  let identity = value?.assetKey
    ? (filenames[value.assetKey] ?? value.assetKey.split('/').at(-1))
    : undefined;
  if (value?.url) {
    try {
      const source = new URL(value.url);
      if (source.protocol === 'https:')
        identity = decodeURIComponent(
          source.pathname.split('/').filter(Boolean).at(-1) ?? source.hostname,
        );
    } catch {
      // The canonical validator reports incomplete or malformed URLs.
    }
  }
  return (
    <div className={styles.field}>
      {media !== 'document' && (
        <ReferenceUpload
          media={media}
          label={label}
          contextKey={`${label}:${JSON.stringify(value)}`}
          authenticated={authenticated}
          onAttach={(file) => {
            rememberFile(file);
            onChange({ assetKey: file.key });
          }}
        />
      )}
      <div className={styles.asset}>
        <select
          aria-label={`${label} source`}
          value={mode}
          onChange={(event) =>
            onChange(event.target.value === 'owned' ? { assetKey: '' } : { url: '' })
          }
        >
          <option value="url">HTTPS URL</option>
          <option value="owned">Owned input key</option>
        </select>
        <input
          id={id}
          aria-label={`${label} ${mode === 'owned' ? 'owned input key' : 'URL'}`}
          type={mode === 'url' ? 'url' : 'text'}
          autoComplete="off"
          value={value?.assetKey ?? value?.url ?? ''}
          placeholder={mode === 'owned' ? 'Ready, workspace-owned input key' : 'https://…'}
          onChange={(event) =>
            onChange(
              event.target.value
                ? mode === 'owned'
                  ? { assetKey: event.target.value }
                  : { url: event.target.value }
                : undefined,
            )
          }
        />
      </div>
      {identity && (
        <p className={styles.attachment}>
          <strong>{identity}</strong>
          <span className={styles.note}>
            {mode === 'owned'
              ? 'Workspace input · checked at admission'
              : 'External URL · checked at admission'}
          </span>
        </p>
      )}
      {value && (
        <div className={styles.actions}>
          <button type="button" onClick={() => onChange(undefined)}>
            Clear {label.toLowerCase()}
          </button>
        </div>
      )}
    </div>
  );
}

function ReferencesEditor({
  value = [],
  modelId,
  operation,
  authenticated,
  onChange,
  filenames,
  rememberFile,
}: {
  value?: MediaReference[];
  modelId: string;
  operation: Operation;
  authenticated: boolean;
  onChange: (value: MediaReference[] | undefined) => void;
  filenames: Record<string, string>;
  rememberFile: (file: UploadedReference) => void;
}) {
  const caps = getGenerationDefinition(modelId, operation)!.capabilities.references;
  const latest = useRef(value);
  latest.current = value;
  function commit(next: MediaReference[]) {
    latest.current = next;
    onChange(next.length ? next : undefined);
  }
  function update(index: number, next: MediaReference) {
    commit(latest.current.map((reference, position) => (position === index ? next : reference)));
  }
  function move(index: number, direction: number) {
    const next = [...latest.current];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    commit(next);
  }
  const full = (type: MediaReference['type'], list = value) =>
    list.filter((reference) => reference.type === type).length >= (caps.maximum[type] ?? 50) ||
    list.length >= (caps.totalMaximum ?? 50);
  return (
    <div className={styles.wide}>
      <span className={styles.label}>
        References <span className={styles.optional}>ordered media roles</span>
      </span>
      <p className={styles.note}>
        {Object.entries(caps.maximum)
          .map(([type, maximum]) => `${type}: up to ${maximum}`)
          .join(' · ')}
        {caps.totalMaximum !== undefined ? ` · combined maximum ${caps.totalMaximum}` : ''}. Frames
        and references may have additional combination restrictions.
      </p>
      {value.map((reference, index) => (
        <div className={styles.structured} key={index}>
          <div className={styles.label}>Reference {index + 1}</div>
          <label className={styles.field}>
            Media role
            <select
              aria-label={`Reference ${index + 1} media role`}
              value={reference.type}
              onChange={(event) =>
                update(index, { ...reference, type: event.target.value as MediaReference['type'] })
              }
            >
              {!caps.types.includes(reference.type) && (
                <option value={reference.type}>{reference.type} (unsupported)</option>
              )}
              {caps.types.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <AssetEditor
            label={`Reference ${index + 1}`}
            value={reference.asset}
            media={reference.type}
            authenticated={authenticated}
            filenames={filenames}
            rememberFile={rememberFile}
            onChange={(asset) => update(index, { ...reference, asset: asset ?? { url: '' } })}
          />
          <div className={styles.actions}>
            <button
              type="button"
              aria-label={`Move reference ${index + 1} earlier`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move earlier
            </button>
            <button
              type="button"
              aria-label={`Move reference ${index + 1} later`}
              disabled={index === value.length - 1}
              onClick={() => move(index, 1)}
            >
              Move later
            </button>
            <button
              type="button"
              onClick={() => commit(latest.current.filter((_, position) => position !== index))}
            >
              Remove reference {index + 1}
            </button>
          </div>
        </div>
      ))}
      {caps.types
        .filter((type) => type !== 'document')
        .filter((type) => !full(type))
        .map((type) => (
          <ReferenceUpload
            key={type}
            media={type}
            label="new reference"
            authenticated={authenticated}
            onAttach={(file) => {
              if (full(type, latest.current)) return false;
              rememberFile(file);
              commit([...latest.current, { type, asset: { assetKey: file.key } }]);
            }}
          />
        ))}
      <div className={styles.actions}>
        {caps.types.map((type) => (
          <button
            type="button"
            key={type}
            disabled={full(type)}
            onClick={() => commit([...latest.current, { type, asset: { url: '' } }])}
          >
            + Add {type} reference
          </button>
        ))}
      </div>
    </div>
  );
}

function StructuredEditor({
  field,
  value,
  onChange,
  onPending,
}: {
  field: PlaygroundField;
  value: unknown;
  onChange: (value: unknown) => void;
  onPending: (name: ArgumentName, pending: boolean) => void;
}) {
  const applied = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [text, setText] = useState(applied);
  const [error, setError] = useState('');
  const dirty = text !== applied;
  const id = useId();
  useEffect(() => {
    setText(applied);
    setError('');
  }, [applied]);
  useEffect(() => {
    onPending(field.name, dirty);
    return () => onPending(field.name, false);
  }, [dirty, field.name, onPending]);
  return (
    <div className={`${styles.wide} ${styles.structured}`}>
      <label className={styles.field} htmlFor={id}>
        <span className={styles.label}>
          {labels[field.name]} <span className={styles.optional}>structured JSON</span>
        </span>
        <textarea
          id={id}
          value={text}
          rows={5}
          spellCheck={false}
          placeholder={JSON.stringify(examples[field.name], null, 2)}
          aria-describedby={`${id}-help`}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setText(event.target.value);
            setError('');
          }}
        />
      </label>
      <p id={`${id}-help`} className={styles.note}>
        Apply one complete value.{' '}
        {field.name === 'keyframes'
          ? `Frame limit: ${field.schema.maxItems}. Timed positions use seconds when supported.`
          : field.name === 'size'
            ? 'Width and height are pixels. Exact size cannot be combined with resolution or aspect ratio.'
            : field.name === 'elements'
              ? 'Each element has a stable ID and either images or video, with optional voice.'
              : 'Each shot has its own prompt and duration.'}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            try {
              const next = parseStructuredArgument(field.name, text);
              onChange(next);
              setError('');
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Check this value.');
            }
          }}
        >
          Apply {labels[field.name].toLowerCase()}
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            setText(applied);
            setError('');
          }}
        >
          Discard edit
        </button>
        {value !== undefined && (
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              setText('');
              setError('');
            }}
          >
            Clear {labels[field.name].toLowerCase()}
          </button>
        )}
      </div>
      {dirty && (
        <p className={styles.note}>
          Unapplied edit. Apply or discard it before quoting, exporting or generating.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** All model/operation arguments use the same parent-owned canonical input as JSON and quote. */
export function CanonicalControls({
  modelId,
  operation,
  route,
  value,
  authenticated,
  onChange,
  onValidityChange,
}: {
  modelId: string;
  operation: Operation;
  route?: Route;
  value: GenerationArguments;
  authenticated: boolean;
  onChange: (value: GenerationArguments) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const fields = useMemo(
    () => getPlaygroundFields(modelId, operation, route),
    [modelId, operation, route],
  );
  const prefix = useId();
  const definition = getGenerationDefinition(modelId, operation);
  const [pending, setPending] = useState<Partial<Record<ArgumentName, boolean>>>({});
  const [filenames, setFilenames] = useState<Record<string, string>>({});
  const latestInput = useRef(value);
  latestInput.current = value;
  const rememberFile = ({ key, name }: UploadedReference) =>
    setFilenames((current) => ({ ...current, [key]: name }));
  const onPending = useMemo(
    () => (name: ArgumentName, dirty: boolean) =>
      setPending((current) => (current[name] === dirty ? current : { ...current, [name]: dirty })),
    [],
  );
  const valid = !Object.values(pending).some(Boolean);
  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);
  const allowed = new Set(fields.map((field) => field.name));
  const unsupported = Object.keys(value).filter((name) => !allowed.has(name as ArgumentName));
  function set(name: ArgumentName, next: unknown) {
    const changed = { ...latestInput.current, [name]: next };
    if (next === undefined) delete changed[name];
    latestInput.current = changed;
    onChange(changed);
  }
  function renderField(field: PlaygroundField) {
    const { name } = field;
    const current = value[name];
    if (name === 'references')
      return (
        <ReferencesEditor
          key={name}
          modelId={modelId}
          operation={operation}
          value={value.references}
          authenticated={authenticated}
          filenames={filenames}
          rememberFile={rememberFile}
          onChange={(next) => set(name, next)}
        />
      );
    if (assets.has(name))
      return (
        <div className={styles.wide} key={name}>
          <span className={styles.label}>
            {labels[name]}
            <span className={styles.optional}>{field.required ? 'required' : 'optional'}</span>
          </span>
          <AssetEditor
            label={labels[name]}
            value={current as AssetRef | undefined}
            media={name === 'sourceVideo' ? 'video' : name === 'targetAudio' ? 'audio' : 'image'}
            authenticated={authenticated}
            filenames={filenames}
            rememberFile={rememberFile}
            onChange={(next) => set(name, next)}
          />
        </div>
      );
    if (structured.has(name))
      return (
        <StructuredEditor
          key={name}
          field={field}
          value={current}
          onChange={(next) => set(name, next)}
          onPending={onPending}
        />
      );
    const placeholder =
      field.schema.default !== undefined
        ? `Model default: ${String(field.schema.default)}`
        : 'Model default';
    const multiline = ['prompt', 'negativePrompt', 'systemPrompt'].includes(name);
    const numeric =
      field.schema.type === 'number' || field.schema.type === 'integer' || name === 'duration';
    const choices = field.choices;
    const missingChoice =
      current !== undefined && choices && !choices.includes(current as string | number | boolean);
    const id = `${prefix}-${name}`;
    return (
      <div className={multiline ? styles.wide : styles.field} key={name}>
        <label htmlFor={id} className={styles.label}>
          {labels[name]}
          <span className={styles.optional}>{field.required ? 'required' : 'optional'}</span>
        </label>
        {choices ? (
          <select
            id={id}
            aria-label={labels[name]}
            required={field.required}
            value={current === undefined ? '' : String(current)}
            onChange={(event) =>
              set(
                name,
                event.target.value === ''
                  ? undefined
                  : (choices.find((choice) => String(choice) === event.target.value) ?? current),
              )
            }
          >
            <option value="">{placeholder}</option>
            {missingChoice && (
              <option value={String(current)}>{String(current)} (not supported here)</option>
            )}
            {choices.map((choice) => (
              <option key={JSON.stringify(choice)} value={String(choice)}>
                {typeof choice === 'boolean'
                  ? choice
                    ? 'On'
                    : 'Off'
                  : name === 'duration' && typeof choice === 'number'
                    ? `${choice} seconds`
                    : String(choice)}
              </option>
            ))}
          </select>
        ) : multiline ? (
          <textarea
            id={id}
            aria-label={labels[name]}
            required={field.required}
            rows={name === 'prompt' ? 4 : 3}
            value={(current as string) ?? ''}
            maxLength={
              typeof field.schema.maxLength === 'number' ? field.schema.maxLength : undefined
            }
            placeholder={name === 'prompt' ? 'Describe the result you have in mind…' : undefined}
            onChange={(event) =>
              set(name, event.target.value === '' ? undefined : event.target.value)
            }
          />
        ) : (
          <input
            id={id}
            aria-label={labels[name]}
            required={field.required}
            type={numeric && current !== 'auto' ? 'number' : 'text'}
            value={(current as string | number) ?? ''}
            placeholder={placeholder}
            min={field.minimum}
            max={field.maximum}
            step={
              field.schema.type === 'integer' ||
              (name === 'duration' && definition?.capabilities.duration?.integer)
                ? 1
                : 'any'
            }
            onChange={(event) =>
              set(
                name,
                event.target.value === ''
                  ? undefined
                  : numeric && event.target.value !== 'auto'
                    ? Number(event.target.value)
                    : event.target.value,
              )
            }
          />
        )}
        {name === 'duration' && !choices && definition?.capabilities.duration?.auto && (
          <span className={styles.actions}>
            <button
              type="button"
              onClick={() => set(name, current === 'auto' ? undefined : 'auto')}
            >
              {current === 'auto' ? 'Use model default' : 'Use automatic duration'}
            </button>
          </span>
        )}
        {name === 'audio' && (
          <span className={styles.note}>
            {definition?.capabilities.audio === 'always-on'
              ? 'This model always generates audio.'
              : definition?.capabilities.audio === 'unsupported'
                ? 'Audio is unsupported by this model.'
                : definition?.capabilities.audio === 'unverified'
                  ? 'Audio control is unverified for this model.'
                  : 'Choose generated audio explicitly, or keep the model default.'}
          </span>
        )}
        {name === 'count' && (
          <span className={styles.note}>
            Maximum {field.maximum} output{field.maximum === 1 ? '' : 's'} per request.
          </span>
        )}
      </div>
    );
  }
  return (
    <div className={styles.controls}>
      <div className={styles.grid}>
        {fields.filter((field) => !field.advanced).map(renderField)}
      </div>
      <details className={styles.advanced}>
        <summary>Advanced and model-specific controls</summary>
        <div className={styles.grid}>
          {fields.filter((field) => field.advanced).map(renderField)}
        </div>
      </details>
      {unsupported.length > 0 && (
        <div className={styles.unsupported} role="alert">
          <p>
            These saved arguments are incompatible with this model/operation. They remain in your
            request until you remove them.
          </p>
          {unsupported.map((name) => (
            <div className={styles.field} key={name}>
              <code>
                {name}: {JSON.stringify(value[name as ArgumentName])}
              </code>
              <div className={styles.actions}>
                <button type="button" onClick={() => set(name as ArgumentName, undefined)}>
                  Remove {name}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
