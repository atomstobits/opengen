'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePlaygroundAuthority } from './playground-authority';
import styles from './playground-controls.module.css';

export type UploadedReference = { key: string; name: string };

const mediaTypes = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/webm',
  audio: 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/webm,audio/ogg,audio/flac',
};

export function ReferenceUpload({
  authenticated,
  media,
  label,
  contextKey,
  onAttach,
}: {
  authenticated: boolean;
  media: 'image' | 'video' | 'audio';
  label: string;
  /** Invalidates a pending upload when its destination row or authorized editor changes. */
  contextKey?: string;
  onAttach: (value: UploadedReference) => boolean | void;
}) {
  const authority = usePlaygroundAuthority();
  const helpId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const activeUpload = useRef<AbortController | null>(null);
  const attach = useRef(onAttach);
  attach.current = onAttach;
  useEffect(() => {
    setBusy(false);
    setError('');
    return () => activeUpload.current?.abort();
  }, [authenticated, media, contextKey]);
  async function upload(file: File) {
    if (!authenticated || busy) return;
    setError('');
    setAnnouncement('');
    if (!mediaTypes[media].split(',').includes(file.type) || !file.size) {
      setError(`Choose a supported, nonempty ${media} file.`);
      return;
    }
    const controller = new AbortController();
    activeUpload.current?.abort();
    activeUpload.current = controller;
    setBusy(true);
    setError('');
    let key: string | undefined;
    try {
      const prepared = await fetch('/api/assets', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authority },
        body: JSON.stringify({ mediaType: file.type, size: file.size }),
      });
      const preparedBody = await prepared.json();
      if (!prepared.ok)
        throw new Error(
          typeof preparedBody.error === 'string'
            ? preparedBody.error
            : (preparedBody.error?.message ?? 'Upload could not be prepared.'),
        );
      const plan = preparedBody.data ?? preparedBody;
      key = plan.key;
      const sent = await fetch(plan.uploadUrl, {
        signal: controller.signal,
        method: 'PUT',
        headers: plan.headers,
        body: file,
        credentials: 'omit',
      });
      if (!sent.ok)
        throw new Error(
          'The file could not be uploaded. Check your storage connection and try again.',
        );
      const completed = await fetch('/api/assets/complete', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authority },
        body: JSON.stringify({ key }),
      });
      const completedBody = await completed.json();
      if (!completed.ok)
        throw new Error(
          typeof completedBody.error === 'string'
            ? completedBody.error
            : (completedBody.error?.message ?? 'Upload could not be verified.'),
        );
      const asset = completedBody.data ?? completedBody;
      if (controller.signal.aborted) return;
      if (
        asset.state !== 'ready' ||
        asset.assetKey !== key ||
        asset.deletionPending ||
        (asset.expiresAt !== null &&
          (!Number.isFinite(Date.parse(asset.expiresAt)) ||
            Date.parse(asset.expiresAt) <= Date.now()))
      )
        throw new Error(`This file is ${asset.state}. Only ready owned inputs can be used.`);
      const name = file.name || `Pasted ${media}`;
      if (attach.current({ key: key!, name }) === false)
        throw new Error('The reference limit was reached while this file was uploading.');
      setAnnouncement(`${name} attached privately.`);
      key = undefined;
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'The reference could not be uploaded.');
    } finally {
      if (key)
        void fetch('/api/assets', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', ...authority },
          body: JSON.stringify({ key }),
        }).catch(() => {});
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div
      className={styles.intake}
      onPaste={(event) => {
        const file = event.clipboardData.files[0];
        if (file && authenticated && !busy) {
          event.preventDefault();
          void upload(file);
        }
      }}
      onDragOver={(event) => {
        if (authenticated && !busy && event.dataTransfer.types.includes('Files'))
          event.preventDefault();
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files[0];
        if (!file) return;
        event.preventDefault();
        void upload(file);
      }}
    >
      <label className={`upload-picker ${!authenticated || busy ? 'disabled' : ''}`}>
        <span>{busy ? 'Uploading…' : `Choose ${media} file`}</span>
        <input
          type="file"
          aria-label={`Upload ${label.toLowerCase()} ${media}`}
          aria-describedby={helpId}
          accept={mediaTypes[media]}
          disabled={!authenticated || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
      </label>
      <span className={styles.note} id={helpId}>
        {authenticated
          ? 'Paste or drop one file here. Uploads stay private to your workspace.'
          : 'Connect a workspace with generate access to upload private files.'}
      </span>
      <span className={styles.uploadStatus} role="status">
        {busy ? 'Uploading private file…' : announcement}
      </span>
      {error && (
        <p className="access-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
