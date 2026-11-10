import type { GenerateInput, Route } from '@media-router/contracts';

/** An operator-selected qualification boundary, not a declaration of live support. */
export interface ExecutionScope {
  profile: 'unrestricted' | 'qualification-sg-v1';
  /** Operator-verified owned qualification fixture; never a generation argument. */
  firstFrameSha256?: string;
}

export function readExecutionScopeConfiguration(env: NodeJS.ProcessEnv): ExecutionScope {
  return validateExecutionScope({
    profile: (env.OPENGEN_EXECUTION_SCOPE ?? 'unrestricted') as ExecutionScope['profile'],
    ...(env.OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256 === undefined
      ? {}
      : { firstFrameSha256: env.OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256 }),
  });
}

export function validateExecutionScope(scope: ExecutionScope): ExecutionScope {
  if (
    !['unrestricted', 'qualification-sg-v1'].includes(scope.profile) ||
    (scope.firstFrameSha256 !== undefined &&
      (scope.profile !== 'qualification-sg-v1' || !/^[a-f0-9]{64}$/i.test(scope.firstFrameSha256)))
  )
    throw new Error('Invalid operator execution scope or qualification fixture fingerprint.');
  return Object.freeze({
    profile: scope.profile,
    ...(scope.firstFrameSha256 === undefined
      ? {}
      : { firstFrameSha256: scope.firstFrameSha256.toLowerCase() }),
  });
}

const deploymentId = 'alibaba-model-studio-ap-southeast-1';
const routes = new Map([
  ['alibaba/wan-3.0', 'alibaba/ap-southeast-1/wan-3.0'],
  ['alibaba/wan-3.0-prime', 'alibaba/ap-southeast-1/wan-3.0-prime'],
  ['qwen/image-2.1-turbo', 'alibaba-model-studio-ap-southeast-1/qwen-image-2.1-turbo'],
]);
export const executionScopeNotice =
  'This runtime uses a bounded qualification scope. Configuration and scope eligibility do not establish live provider verification or public launch availability.';
export const executionScopeReason =
  'This request is outside this runtime’s operator-selected qualification scope.';

/** Input must be canonical. Only existing documented adapter defaults are accepted. */
export function executionScopeAllows(
  scope: ExecutionScope,
  route: Pick<Route, 'id' | 'modelId' | 'deploymentId'>,
  input?: GenerateInput,
): boolean {
  if (scope.profile === 'unrestricted') return true;
  if (route.deploymentId !== deploymentId || routes.get(route.modelId) !== route.id) return false;
  if (!input) return true; // Configuration inventory only; an exact request quote is still required.
  if (
    input.modelId !== route.modelId ||
    (input.routeId !== undefined && input.routeId !== route.id) ||
    (input.billing ?? 'managed') !== 'managed' ||
    input.routing?.fallback === true ||
    input.previousJobId !== undefined ||
    input.feeAcceptance !== undefined
  )
    return false;
  const args = input.input;
  if ((args.count ?? 1) !== 1) return false;
  if (input.modelId === 'qwen/image-2.1-turbo')
    return (
      input.operation === 'text-to-image' &&
      args.resolution === '1K' &&
      (args.aspectRatio ?? '1:1') === '1:1' &&
      (args.watermark ?? true) === true &&
      (args.promptExtend ?? false) === false &&
      (args.thinking ?? false) === false &&
      Object.keys(args).every((key) =>
        [
          'prompt',
          'resolution',
          'aspectRatio',
          'count',
          'watermark',
          'promptExtend',
          'thinking',
        ].includes(key),
      )
    );
  const image = input.operation === 'image-to-video';
  return (
    (image || input.operation === 'text-to-video') &&
    args.resolution === '480p' &&
    args.duration === 2 &&
    args.aspectRatio === (image ? 'source' : '16:9') &&
    (!image || Boolean(scope.firstFrameSha256 && args.firstFrame?.assetKey)) &&
    Object.keys(args).every((key) =>
      [
        'prompt',
        'resolution',
        'duration',
        'count',
        'aspectRatio',
        ...(image ? ['firstFrame'] : []),
      ].includes(key),
    )
  );
}
