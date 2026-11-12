/** Primary documentation reviewed 2026-11-03. Documentation is not an interoperability test. */
export const AGENT_REVIEW_DATE = '2026-11-03';
export type AgentClient = {
  slug: string;
  name: string;
  monogram: string;
  kind: 'Hosted assistant' | 'Local agent' | 'CLI / API';
  summary: string;
  approach: string;
  steps: string[];
  caution: string;
  source: { label: string; url: string };
  snippet?: (origin: string) => { label: string; code: string };
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
      'Name it OpenGen, enter your configured gateway’s /mcp URL and select OAuth. Use dynamic client registration (DCR); OpenGen does not advertise Client ID Metadata Documents.',
      'Review the plugin, install it and complete OpenGen’s workspace consent. Invoke the installed plugin with @ in a new conversation.',
    ],
    caution:
      'A public HTTPS gateway and configured sign-in are required. Creating a plugin does not verify that its tools or authorization work.',
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
      'Open Customize → Connectors and add a custom connector with your gateway’s /mcp URL. Team and Enterprise setup may require an owner.',
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
      'OpenGen accepts registered localhost callbacks with explicit ports, as documented by Claude Code. The complete callback URI must match registration. No Claude Code version has been tested with OpenGen.',
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
      'These commands follow current official documentation. The installed client’s command options and OAuth callback must be checked; no Codex version has completed an OpenGen interoperability test.',
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
    summary: 'Use the documented remote OAuth configuration and a browser sign-in.',
    approach: 'HTTP MCP with OAuth or OpenGen CLI',
    steps: [
      'Review a change to Hermes config.yaml under mcp_servers. Merge the URL and auth: oauth entry below without replacing other configuration.',
      'From a fresh terminal, run hermes mcp login opengen and complete OpenGen’s browser consent.',
      'Check connection and tool discovery before allowing generation. Remote or headless sessions may need a different callback arrangement.',
    ],
    caution:
      'Hermes documents automatic DCR fallback when CIMD is absent. This is a candidate integration; callback handling, token refresh and tool calls have not been tested with OpenGen.',
    source: {
      label: 'Hermes MCP documentation',
      url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
    },
    snippet: (origin) => ({
      label: 'Entry to merge into your existing YAML settings',
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
      'Install @opengen-dev/cli into an isolated prefix on Node 22.12+ (npm install --prefix /absolute/private/opengen-client @opengen-dev/cli --ignore-scripts --no-audit --no-fund) or use the reviewed offline release bundle; no source checkout is needed.',
      'Complete opengen login in an interactive terminal with the intended gateway configured, then run opengen doctor.',
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
    summary: 'A documented custom MCP path, pending OpenGen-specific verification.',
    approach: 'Custom remote MCP, unverified',
    steps: [
      'Use the client’s custom MCP setup to add your configured gateway’s /mcp URL. The official guide also allows asking a Bot to add a server by URL.',
      'Review any configuration change, then use the client’s authentication card to sign in and choose the OpenGen workspace.',
      'Check tool discovery before generation. Installing an app and completing authorization are separate steps.',
    ],
    caution:
      'Treg references Grok Bot, but that does not establish OpenGen compatibility. OAuth registration, callback, scopes and billable-tool confirmations need a real client test. No OpenGen marketplace plugin is published.',
    source: {
      label: 'Grok Bot app documentation',
      url: 'https://docs.x.ai/grok-bot/computer-and-apps',
    },
  },
  {
    slug: 'cli',
    name: 'CLI & API',
    monogram: '>_',
    kind: 'CLI / API',
    summary: 'Use the portable CLI with browser login, or create one scoped workspace API key.',
    approach: 'OpenGen browser PKCE login / scoped API key',
    steps: [
      'Install @opengen-dev/cli into an isolated prefix on Node 22.12 or later (npm install --prefix /absolute/private/opengen-client @opengen-dev/cli --ignore-scripts --no-audit --no-fund), or use the checksum-verified offline release bundle.',
      'Configure MEDIA_ROUTER_URL for your gateway, then run login and status below. Review the paying workspace and read/generate permissions in your browser.',
      'For a backend API integration, create a separate expiring read/generate key in Workspace → API keys. Save it once in your application’s secret manager and send it only in the Authorization header.',
    ],
    caution:
      'Local protocol fixtures cover login and private-profile behavior, not a deployed identity provider. Sign-in provides no credit. Do not pass tokens in command arguments, URLs or checked-in files.',
    source: { label: 'OpenGen CLI guide', url: '/docs#agents' },
    snippet: (origin) => ({
      label: 'After installing the reviewed CLI · gateway URL is public configuration',
      code: `export MEDIA_ROUTER_URL="${origin}"\nopengen login\nopengen doctor\nopengen catalog search "image"`,
    }),
  },
];

export function findAgentClient(slug: string): AgentClient | undefined {
  return agentClients.find((client) => client.slug === slug);
}
