#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  applyBinding,
  previewBinding,
  bindingLoginStatus,
  type BindingClient,
} from './bindings.js';

export const bindingHelp = `OpenGen client binding (source-checkout helper)

  preview --client cursor|claude-code --config /absolute/path/mcp.json --url https://opengen.example
  apply   --client cursor|claude-code --config /absolute/path/mcp.json --url https://opengen.example --preview-id <previewId>
  status  --url https://opengen.example [--profile /absolute/private/auth.json]

Claude Code uses project .mcp.json. Cursor uses mcp.json. Only plain JSON is supported.
Review preview before apply. Replacing a different opengen entry requires --replace in both.
No default client config destination is chosen. No credentials are accepted in argv.
Bindings contain the remote URL only; authenticate through the client's own OAuth browser flow.
status reads local private profile metadata without refreshing credentials or verifying access. Use opengen doctor for gateway diagnosis.
There is no local stdio bridge in this checkpoint; this helper does not install software.
`;

export async function runBindingCommand(args: string[]): Promise<unknown> {
  // Reject unknown flags without echoing their names or values (which may be accidental secrets).
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: 'boolean' },
        client: { type: 'string' },
        config: { type: 'string' },
        url: { type: 'string' },
        'preview-id': { type: 'string' },
        replace: { type: 'boolean' },
        profile: { type: 'string' },
      },
    });
  } catch {
    throw new Error(
      'Invalid binding arguments. Run this helper with --help; private arguments were not printed.',
    );
  }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) return bindingHelp;
  if (positionals.length !== 1 || !values.url)
    throw new Error('Choose preview, apply or status and supply --url.');
  const [command] = positionals;
  if (command === 'status') {
    if (values.client || values.config || values['preview-id'] || values.replace)
      throw new Error('status accepts --url and optional --profile only.');
    if (values.profile && !values.profile.startsWith('/'))
      throw new Error('The private profile path must be absolute.');
    return bindingLoginStatus({ baseUrl: values.url, profilePath: values.profile });
  }
  if (!values.client || !values.config || values.profile)
    throw new Error(
      'Binding requires --client and --config; a private profile is never copied into client config.',
    );
  const input = {
    client: values.client as BindingClient,
    configPath: values.config,
    baseUrl: values.url,
    replace: values.replace,
  };
  if (command === 'preview') {
    if (values['preview-id']) throw new Error('preview does not accept --preview-id.');
    return previewBinding(input);
  }
  if (command === 'apply' && values['preview-id'])
    return applyBinding({ ...input, previewId: values['preview-id'] });
  throw new Error('Use preview first, then apply with its --preview-id.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBindingCommand(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(
        typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Client binding failed.'}\n`,
      );
      process.exitCode = 1;
    });
}
