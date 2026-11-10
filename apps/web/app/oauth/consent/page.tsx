import { pageMetadata } from '../../seo';
import { McpConsent } from './consent';
export const metadata = pageMetadata({
  title: 'Connect an agent | OpenGen',
  description: 'Authorize a client for an OpenGen workspace.',
  path: '/oauth/consent',
  noindex: true,
});
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const query = await searchParams;
  return <McpConsent requestId={query.request ?? ''} />;
}
