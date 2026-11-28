/** Primary documentation reviewed 2026-11-03. Documentation is not an interoperability test. */
export const AGENT_REVIEW_DATE = '2026-11-03';
/** Latest live client interoperability evidence recorded on /agents. */
export const AGENT_EVIDENCE_DATE = '2026-11-27';
export type AgentClient = {
  slug: string;
  name: string;
  monogram: string;
  kind: 'Hosted assistant' | 'Local agent' | 'CLI / API';
  reviewedAt?: string;
  summary: string;
  approach: string;
  steps: string[];
  caution: string;
  source: { label: string; url: string };
  verification?: {
    cardLabel: string;
    badge: string;
    matrixEvidence: string;
    detailEvidence: string;
  };
  snippet?: (origin: string) => { label: string; code: string };
  secondarySnippet?: (origin: string) => { label: string; code: string };
};

export const agentClients: AgentClient[] = [
  {
    slug: 'chatgpt',
    name: 'ChatGPT',
    monogram: 'Cg',
    kind: 'Hosted assistant',
    summary: 'Add a custom MCP plugin and authorize a paying workspace in your browser.',
    approach: 'Hosted MCP with OAuth',
    steps: [
      'On ChatGPT web, open Plugins, select the plus button and Add custom MCP server. Workspace permissions can restrict this option.',
      'Name it OpenGen, enter https://opengen.dev/mcp (or your self-hosted gateway’s /mcp URL) and select OAuth. Use dynamic client registration (DCR); OpenGen does not advertise Client ID Metadata Documents.',
      'Review the plugin, install it and complete OpenGen’s workspace consent. Invoke the installed plugin with @ in a new conversation.',
    ],
    caution:
      'Hosted OAuth is live on https://opengen.dev; self-hosted gateways need public HTTPS and configured sign-in. Creating a plugin does not verify end-to-end ChatGPT client interoperability.',
    source: {
      label: 'Official OpenAI documentation',
      url: 'https://developers.openai.com/api/docs/guides/custom-mcp-server',
    },
  },
  {
    slug: 'claude',
    name: 'Claude',
    monogram: 'Cl',
    kind: 'Hosted assistant',
    summary: 'Use a remote connector, with no local installer or provider credentials.',
    approach: 'Remote connector with OAuth',
    steps: [
      'Open Customize → Connectors and add a custom connector with https://opengen.dev/mcp (or your self-hosted gateway’s /mcp URL). Team and Enterprise setup may require an owner.',
      'Choose sign-in authentication and Register automatically for the OAuth client. OpenGen supports dynamic registration, not Claude’s published CIMD identity.',
      'Connect, review the OpenGen consent screen and enable the connector for your conversation.',
    ],
    caution:
      'Remote Claude connections originate from Anthropic’s servers. A gateway reachable only on your laptop or private network cannot serve this path.',
    source: {
      label: 'Claude custom connector guide',
      url: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
    },
  },
  {
    slug: 'claude-code',
    name: 'Claude Code',
    monogram: 'Cc',
    kind: 'Local agent',
    summary: 'Register an HTTP MCP server, then use the client’s browser authorization.',
    approach: 'Remote HTTP MCP or OpenGen CLI',
    steps: [
      'Review the HTTP registration command below before running it. It changes Claude Code’s MCP configuration.',
      'Open /mcp inside Claude Code, choose OpenGen and complete browser sign-in and workspace consent.',
      'Check connection status and ask for catalog discovery before requesting a generation.',
    ],
    caution:
      'OpenGen accepts registered localhost callbacks with explicit ports, as documented by Claude Code. The complete callback URI must match registration. Claude Code 2.1.301 completed live DCR + S256 PKCE redirect through OpenGen’s consent screen on 2026-11-27; post-consent tool execution and billable generation remain pending.',
    verification: {
      cardLabel: 'Live DCR + consent preflight verified',
      badge: 'OAUTH PREFLIGHT VERIFIED',
      matrixEvidence:
        'Claude Code 2.1.301 (2026-11-27): live DCR + S256 PKCE reached workspace consent; post-consent tool calls pending',
      detailEvidence:
        'Claude Code 2.1.301 (2026-11-27): live DCR + S256 PKCE against https://opengen.dev/mcp reached OpenGen workspace consent. Post-consent tool execution and paid generation are pending.',
    },
    source: { label: 'Claude Code MCP documentation', url: 'https://code.claude.com/docs/en/mcp' },
    snippet: (origin) => ({
      label: 'Client configuration command · review before running',
      code: `claude mcp add --transport http opengen ${origin}/mcp`,
    }),
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    monogram: 'Cu',
    kind: 'Local agent',
    summary: 'Preview a URL-only MCP configuration and authorize through Cursor.',
    approach: 'Streamable HTTP MCP or OpenGen CLI',
    steps: [
      'Open Cursor’s Customize page to manage MCP servers, or review a change to your chosen mcp.json.',
      'Add the URL-only entry below while preserving your other servers. Let Cursor initiate OAuth rather than adding a bearer header.',
      'Review the selected OpenGen workspace and permissions in your browser; then check that catalog tools are available.',
    ],
    caution:
      'OpenGen accepts Cursor’s documented HTTPS callback and explicit-port localhost callback when registered exactly. No Cursor version has been tested with OpenGen.',
    source: { label: 'Cursor MCP documentation', url: 'https://cursor.com/docs/mcp' },
    snippet: (origin) => ({
      label: 'Entry to merge into your existing settings',
      code: JSON.stringify({ mcpServers: { opengen: { url: `${origin}/mcp` } } }, null, 2),
    }),
  },
  {
    slug: 'codex',
    name: 'Codex',
    monogram: 'Cx',
    kind: 'Local agent',
    summary: 'Add a Streamable HTTP server and use OAuth login with read/generate scopes.',
    approach: 'Native MCP OAuth or OpenGen CLI',
    steps: [
      'Review the commands below. Adding a server changes the MCP configuration shared by the Codex CLI and IDE.',
      'Run the login command in an interactive terminal and review OpenGen’s consent in your browser.',
      'Inspect MCP status and ask for catalog discovery. A saved server definition alone does not establish a successful connection.',
    ],
    caution:
      'codex-cli 0.155.1 completed live OAuth Streamable HTTP MCP read-only verification (catalog_search, catalog_get, balance) against https://opengen.dev/mcp on 2026-11-27. Billable generation and other Codex versions remain separately unverified.',
    verification: {
      cardLabel: 'Live read-only OAuth MCP verified',
      badge: 'LIVE READ-ONLY VERIFIED',
      matrixEvidence:
        'codex-cli 0.155.1 (2026-11-27): live OAuth MCP read-only verified (catalog_search, catalog_get, balance); generation not run',
      detailEvidence:
        'codex-cli 0.155.1 (2026-11-27): verified live OAuth Streamable HTTP MCP catalog_search, catalog_get, and balance against https://opengen.dev/mcp. Billable generation not exercised.',
    },
    source: {
      label: 'Official OpenAI command reference',
      url: 'https://learn.chatgpt.com/docs/developer-commands',
    },
    snippet: (origin) => ({
      label: 'Client configuration commands · review before running',
      code: `codex mcp add opengen --url ${origin}/mcp\ncodex mcp login opengen --scopes read,generate --oauth-client-registration dcr`,
    }),
  },
  {
    slug: 'muse',
    name: 'Muse',
    monogram: 'Mu',
    kind: 'Local agent',
    reviewedAt: '2026-11-27',
    summary:
      'Add a Streamable HTTP MCP server in Muse Code with native OAuth, or connect in Meta Muse.',
    approach: 'Streamable HTTP MCP (OAuth DCR)',
    steps: [
      'In Muse Code, run the add and login commands below (or merge the mcpServers entry with "schema_version": 1 into ~/.config/muse/settings.json). Use --headless on remote or SSH sessions.',
      'Complete OpenGen browser sign-in and workspace consent, then run muse mcp list or /mcp inside Muse Code to confirm tools load.',
      'In hosted Meta Muse, open Settings → Connectors → Add custom connector, choose remote Streamable HTTP with https://opengen.dev/mcp, and complete OAuth sign-in.',
    ],
    caution:
      'Muse Code settings.json requires top-level "schema_version": 1 alongside mcpServers. Muse Code 1.4.25 completed live OAuth discovery, dynamic client registration (HTTP 201), and S256 PKCE loopback authorization initiation against https://opengen.dev/mcp on 2026-11-27; post-consent tool execution, hosted Meta Muse connectors, and billable generation remain pending.',
    verification: {
      cardLabel: 'Live DCR + PKCE preflight verified',
      badge: 'OAUTH PREFLIGHT VERIFIED',
      matrixEvidence:
        'Muse Code 1.4.25 (2026-11-27): live discovery + DCR + S256 PKCE loopback auth initiated; post-consent tool calls and hosted Meta Muse pending',
      detailEvidence:
        'Muse Code 1.4.25 (2026-11-27): live OAuth discovery, dynamic client registration (HTTP 201), and S256 PKCE authorization initiated against https://opengen.dev/mcp. Post-consent tool execution, hosted Meta Muse connector, and paid generation remain pending.',
    },
    source: { label: 'Meta AI developer documentation', url: 'https://dev.meta.ai/docs' },
    snippet: (origin) => ({
      label: 'Muse Code CLI commands · review before running',
      code: `muse mcp add opengen --url ${origin}/mcp --user\nmuse mcp login opengen`,
    }),
    secondarySnippet: (origin) => ({
      label: 'Equivalent ~/.config/muse/settings.json entry',
      code: JSON.stringify(
        {
          schema_version: 1,
          mcpServers: {
            opengen: {
              type: 'streamable-http',
              url: `${origin}/mcp`,
            },
          },
        },
        null,
        2,
      ),
    }),
  },
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    monogram: 'Oc',
    kind: 'Local agent',
    summary:
      'Use the client’s MCP settings and browser authorization; verify the connection separately.',
    approach: 'Streamable HTTP MCP or OpenGen CLI',
    steps: [
      'In OpenClaw’s Control UI, open Settings → MCP and add a Streamable HTTP server with your gateway’s /mcp URL.',
      'Configure OAuth (auth: oauth) through the scoped editor, then use Sign in for an enabled HTTP server.',
      'After browser consent, check the server with OpenClaw’s MCP diagnostics before using its tools.',
    ],
    caution:
      'OAuth, callback reachability and credential ownership depend on the OpenClaw gateway and version. Instructions are documentation-based; an OpenGen connection has not been tested.',
    source: { label: 'OpenClaw MCP documentation', url: 'https://docs.openclaw.ai/tools/mcp' },
  },
  {
    slug: 'hermes',
    name: 'Hermes Agent',
    monogram: 'He',
    kind: 'Local agent',
    reviewedAt: '2026-11-27',
    summary: 'Register the remote OAuth MCP server with the Hermes CLI or config.yaml.',
    approach: 'HTTP MCP with OAuth or OpenGen CLI',
    steps: [
      'Run the Hermes CLI command below (or merge the mcp_servers entry into Hermes config.yaml without replacing other configuration).',
      'Complete OpenGen’s browser sign-in and workspace consent when prompted, or run hermes mcp login opengen from a fresh terminal.',
      'Check connection and tool discovery with hermes mcp test before allowing generation. Remote or headless sessions may need a different callback arrangement.',
    ],
    caution:
      'Hermes Agent v0.16.0 completed live OAuth discovery, dynamic client registration (HTTP 201), and S256 PKCE loopback authorization initiation against https://opengen.dev/mcp on 2026-11-27; post-consent token refresh, tool execution, and billable generation remain pending.',
    verification: {
      cardLabel: 'Live DCR + PKCE preflight verified',
      badge: 'OAUTH PREFLIGHT VERIFIED',
      matrixEvidence:
        'Hermes Agent v0.16.0 (2026-11-27): live discovery + DCR + S256 PKCE loopback auth initiated; post-consent tool calls pending',
      detailEvidence:
        'Hermes Agent v0.16.0 (2026-11-27): live OAuth discovery, dynamic client registration (HTTP 201), and S256 PKCE authorization initiated against https://opengen.dev/mcp. Post-consent token refresh, tool execution, and paid generation remain pending.',
    },
    source: {
      label: 'Hermes MCP documentation',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
    },
    snippet: (origin) => ({
      label: 'Client configuration command · review before running',
      code: `hermes mcp add opengen --url ${origin}/mcp --auth oauth`,
    }),
    secondarySnippet: (origin) => ({
      label: 'Equivalent config.yaml entry to merge into your settings',
      code: `mcp_servers:\n  opengen:\n    url: "${origin}/mcp"\n    auth: oauth`,
    }),
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    monogram: 'Op',
    kind: 'Local agent',
    summary: 'Configure a remote MCP server and complete the client’s OAuth flow.',
    approach: 'Remote MCP OAuth or OpenGen CLI',
    steps: [
      'Review a change to opencode.json. Merge the remote entry below into your existing mcp object.',
      'Run opencode mcp auth opengen to open authorization in your browser.',
      'Use opencode mcp list to inspect auth status and test discovery before any paid request.',
    ],
    caution:
      'OpenCode documents automatic OAuth and dynamic registration. No OpenCode version, callback, refresh or OpenGen tool call has been verified end to end.',
    source: { label: 'OpenCode MCP documentation', url: 'https://opencode.ai/docs/mcp-servers/' },
    snippet: (origin) => ({
      label: 'Entry to merge into your existing settings',
      code: JSON.stringify({ mcp: { opengen: { type: 'remote', url: `${origin}/mcp` } } }, null, 2),
    }),
  },
  {
    slug: 'pi',
    name: 'pi',
    monogram: 'pi',
    kind: 'Local agent',
    summary: 'Use the portable OpenGen CLI; native MCP is not assumed.',
    approach: 'CLI through the agent’s shell',
    steps: [
      'Install @opengen-dev/cli into an isolated prefix on Node 22.12+ (npm install --prefix "$HOME/.opengen/cli" @opengen-dev/cli --ignore-scripts --no-audit --no-fund) or use the reviewed offline release bundle; no source checkout is needed.',
      'Complete opengen login in an interactive terminal (defaults to https://opengen.dev, or set OPENGEN_API_URL for a self-hosted gateway), then run opengen doctor.',
      'Ask pi to use the documented CLI for catalog discovery. Keep credentials in the private profile, outside the project.',
    ],
    caution:
      'The pi project documents MCP through extensions rather than core support. No extension has been selected or verified; the shell/CLI workflow is also unverified in pi.',
    source: {
      label: 'pi project documentation',
      url: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent',
    },
  },
  {
    slug: 'grok-bot',
    name: 'Grok Bot',
    monogram: 'Gb',
    kind: 'Hosted assistant',
    reviewedAt: '2026-11-27',
    summary: 'Add OpenGen as a custom Remote HTTPS MCP connector in Grok Bot or Grok CLI.',
    approach: 'Custom Remote HTTPS MCP (OAuth DCR)',
    steps: [
      'In Grok Bot, open Connect apps, scroll to the bottom, and select Add a custom connector — or ask a Bot in chat to add a custom remote MCP server named OpenGen at https://opengen.dev/mcp.',
      'Enter OpenGen as the name, choose Remote HTTPS, set Server URL to https://opengen.dev/mcp (or your self-hosted gateway’s /mcp URL), leave Client ID and Client secret blank for OAuth dynamic client registration, and select Add plugin.',
      'Click Authenticate on the OpenGen card to complete sign-in and workspace consent, then test read-only catalog discovery before requesting any generation.',
    ],
    caution:
      'No OpenGen marketplace plugin is published for Grok Bot. Live OAuth registration, callback handling, token refresh, tool discovery, and billable-tool confirmations remain pending a real Grok Bot desktop or Grok CLI client test.',
    source: {
      label: 'Grok Bot app documentation',
      url: 'https://docs.x.ai/grok-bot/computer-and-apps',
    },
    snippet: (origin) => ({
      label: 'Grok CLI registration command · review before running',
      code: `grok mcp add --transport http opengen ${origin}/mcp`,
    }),
    secondarySnippet: (origin) => ({
      label: 'Equivalent ~/.grok/config.toml entry',
      code: `[mcp_servers.opengen]\nurl = "${origin}/mcp"`,
    }),
  },
  {
    slug: 'cli',
    name: 'CLI & API',
    monogram: '>_',
    kind: 'CLI / API',
    reviewedAt: '2026-11-27',
    summary: 'Use the portable CLI with browser login, or create one scoped workspace API key.',
    approach: 'OpenGen browser PKCE login / scoped API key',
    steps: [
      'Install @opengen-dev/cli into an isolated prefix on Node 22.12 or later (npm install --prefix "$HOME/.opengen/cli" @opengen-dev/cli --ignore-scripts --no-audit --no-fund), or install from the checksum-verified offline release bundle, then add "$HOME/.opengen/cli/node_modules/.bin" to your PATH.',
      'Set OPENGEN_API_URL if targeting a self-hosted gateway (defaults to https://opengen.dev; MEDIA_ROUTER_URL remains a supported alias), then run login and doctor below. Review the paying workspace and read/generate permissions in your browser.',
      'For a backend API integration, create a separate expiring read/generate key in Workspace → API keys (/app#keys). Save it once as OPENGEN_API_KEY in your secret manager and send it only in the Authorization header.',
    ],
    caution:
      '@opengen-dev/cli 0.1.2 is published on npm and verified from a clean isolated install on 2026-11-27 for unauthenticated catalog search, doctor, and opengen login live DCR + S256 PKCE initiation against https://opengen.dev; post-consent browser login remains pending. New personal workspaces start with $0 managed credit. Do not pass tokens in command arguments, URLs or checked-in files.',
    verification: {
      cardLabel: 'Live npm install + DCR preflight verified',
      badge: 'OAUTH PREFLIGHT VERIFIED',
      matrixEvidence:
        '@opengen-dev/cli 0.1.2 (2026-11-27): npm clean install, unauthenticated catalog search/doctor, and opengen login DCR + S256 PKCE preflight verified; post-consent browser login pending',
      detailEvidence:
        '@opengen-dev/cli 0.1.2 (2026-11-27): published on npm and verified from a clean isolated install for --version, catalog search, doctor, and opengen login live discovery + DCR (HTTP 201) + S256 PKCE loopback initiation against https://opengen.dev. Post-consent browser login remains pending.',
    },
    source: { label: 'OpenGen CLI guide', url: '/docs#agents' },
    snippet: (origin) => ({
      label: 'Sign in, diagnose your workspace, and search the catalog',
      code: `export OPENGEN_API_URL="${origin}"\nopengen login\nopengen doctor\nopengen catalog search "gpt-image-2"`,
    }),
    secondarySnippet: () => ({
      label: 'Quote first, then submit once with a persisted idempotency key',
      code: `cat <<'EOF' > request.json\n{\n  "modelId": "openai/gpt-image-2",\n  "operation": "text-to-image",\n  "input": {\n    "prompt": "A matte ceramic teapot on dark slate, studio lighting",\n    "resolution": "1K",\n    "quality": "low"\n  },\n  "billing": "managed",\n  "maxCostMicros": 50000\n}\nEOF\nopengen quote --input request.json\n\n# After confirming route, estimate and balance (save OPENGEN_IDEMPOTENCY_KEY once and reuse it on retry):\nopengen generate --input request.json --idempotency-key "\${OPENGEN_IDEMPOTENCY_KEY:?Set and save a unique ID before submitting}"`,
    }),
  },
];

export function findAgentClient(slug: string): AgentClient | undefined {
  return agentClients.find((client) => client.slug === slug);
}
