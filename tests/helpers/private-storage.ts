import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { OutputAsset } from '@media-router/contracts';
import { AssetStore } from '../../packages/engine/src/storage.js';
import {
  createInputKey,
  inputMediaExtension,
  inspectInputBytes,
  maxInputBytes,
} from '../../packages/engine/src/input-media.js';
import type { Engine } from '../../packages/engine/src/index.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
// One locally generated black 16x16 H.264 frame; no provider or remote media.
const mp4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2MC4zLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADACg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAG6gAABuoAAAABhzdHRzAAAAAAAAAAEAAAABAAAIAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAALEAAAAAQAAABRzdGNvAAAAAAAAAAEAAANEAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MC4zLjEwMAAAAAhmcmVlAAACzG1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMDk1IGJhZWU0MDAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIyIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49NSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA9liIQAP//+92ifApteYbk=',
  'base64',
);
const extensions: Record<string, string> = { 'image/png': 'png', 'video/mp4': 'mp4' };

/** In-memory owned object capabilities for admission/ledger fixtures, with no network. */
export function privateStorageFixture(): AssetStore {
  const objects = new Map<string, { bytes: Buffer; mediaType: string }>();
  const sign = async (key: string, mediaType: string): Promise<OutputAsset> => {
    const object = objects.get(key);
    if (!object || object.mediaType !== mediaType) throw new Error('Fixture object not found.');
    return {
      storageKey: key,
      url: `https://private-storage.example/${key}?fixture=owned`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      mediaType,
      fidelity: 'unverified',
      sha256: createHash('sha256').update(object.bytes).digest('hex'),
      byteLength: object.bytes.byteLength,
    };
  };
  // Exercise production input validation/read/write/delete methods against a
  // memory-only S3 transport. No credential resolution or network client exists.
  return Object.assign(Object.create(AssetStore.prototype), {
    bucket: 'synthetic-private-bucket',
    client: {
      send: async (
        command: GetObjectCommand | HeadObjectCommand | PutObjectCommand | DeleteObjectCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        options?.abortSignal?.throwIfAborted();
        const { Bucket, Key } = command.input;
        if (Bucket !== 'synthetic-private-bucket' || !Key)
          throw new Error('Unexpected fixture storage identity.');
        if (command instanceof PutObjectCommand) {
          if (command.input.IfNoneMatch === '*' && objects.has(Key))
            throw Object.assign(new Error('Immutable fixture object already exists.'), {
              $metadata: { httpStatusCode: 412 },
            });
          const bytes = Buffer.from(command.input.Body as Uint8Array);
          if (
            !bytes.length ||
            (command.input.ContentLength !== undefined &&
              command.input.ContentLength !== bytes.length)
          )
            throw new Error('Invalid fixture object bytes.');
          objects.set(Key, {
            bytes,
            mediaType: command.input.ContentType ?? 'application/octet-stream',
          });
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          objects.delete(Key);
          return {};
        }
        if (!(command instanceof GetObjectCommand) && !(command instanceof HeadObjectCommand))
          throw new Error('Unexpected fixture storage command.');
        const object = objects.get(Key);
        if (!object)
          throw Object.assign(new Error('Fixture object not found.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        return {
          ...(command instanceof GetObjectCommand
            ? { Body: Readable.from([Buffer.from(object.bytes)]) }
            : {}),
          ContentLength: object.bytes.byteLength,
          ContentType: object.mediaType,
        };
      },
    },
    prepareUpload: async (workspaceId: string, mediaType: string, size: number) => {
      if (
        !inputMediaExtension(mediaType) ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > maxInputBytes
      )
        throw new Error('Invalid fixture upload declaration.');
      const key = createInputKey(workspaceId, mediaType);
      return {
        key,
        uploadUrl: `https://private-storage.example/${key}?fixture=upload`,
        headers: { 'Content-Type': mediaType, 'If-None-Match': '*' },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    sign,
    putOutput: async ({
      jobId,
      bytes,
      mediaType,
    }: {
      jobId: string;
      bytes: Uint8Array;
      mediaType: string;
    }) => {
      const extension = extensions[mediaType];
      if (!extension || !bytes.byteLength) throw new Error('Unsupported fixture output.');
      const digest = createHash('sha256').update(bytes).digest('hex');
      // A deterministic UUID-shaped slot is accepted by the production owned-key validator.
      const slot = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
      const key = `outputs/${jobId}/${slot}.${extension}`;
      const existing = objects.get(key);
      if (existing && !existing.bytes.equals(Buffer.from(bytes)))
        throw new Error('Immutable fixture output changed.');
      objects.set(key, { bytes: Buffer.from(bytes), mediaType });
      return sign(key, mediaType);
    },
  }) as AssetStore;
}

/** Seed a ready owned object before returning a synthetic provider completion. */
export async function privateOutputFixture(
  storage: AssetStore,
  jobId: string,
  mediaType: 'image/png' | 'video/mp4' = 'video/mp4',
): Promise<OutputAsset> {
  return storage.putOutput({ jobId, bytes: mediaType === 'image/png' ? png : mp4, mediaType });
}

/** Fresh synthetic bytes with facts checked by the same bounded container reader. */
export function privateInputBytesFixture(mediaType: 'image/png' | 'video/mp4' = 'image/png') {
  const bytes = Buffer.from(mediaType === 'image/png' ? png : mp4);
  return { bytes, ...inspectInputBytes(bytes, mediaType) };
}

/** Complete the real staging-to-ready lifecycle; never bypass the owned asset registry. */
export async function privateReadyInputFixture(
  engine: Pick<Engine, 'pool' | 'storage' | 'ownedAssets'>,
  workspaceId: string,
  mediaType: 'image/png' | 'video/mp4' = 'image/png',
) {
  if (!engine.storage || !engine.ownedAssets) throw new Error('Fixture storage is required.');
  const source = privateInputBytesFixture(mediaType);
  const prepared = await engine.ownedAssets.prepareUpload(
    workspaceId,
    mediaType,
    source.byteLength,
  );
  const staged = (
    await engine.pool.query(
      'SELECT upload_key FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2',
      [workspaceId, prepared.key],
    )
  ).rows[0];
  if (!staged?.upload_key) throw new Error('Fixture upload staging is missing.');
  await engine.storage.writeInput(workspaceId, staged.upload_key, source.bytes, mediaType);
  const ready = await engine.ownedAssets.completeUpload(workspaceId, prepared.key);
  return { ...ready, uploadKey: staged.upload_key as string };
}
