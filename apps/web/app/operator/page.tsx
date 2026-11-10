import { pageMetadata } from '../seo';
import { OperatorPanel } from './panel';
import { SiteHeader, Footer } from '../ui';
export const metadata = pageMetadata({
  title: 'Operator reconciliation | OpenGen',
  description: 'Private installation operator reconciliation.',
  path: '/operator',
  noindex: true,
});
export default function OperatorPage() {
  return (
    <>
      <SiteHeader />
      <OperatorPanel />
      <Footer />
    </>
  );
}
