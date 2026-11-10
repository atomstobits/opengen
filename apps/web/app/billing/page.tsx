import { pageMetadata } from '../seo';
import { BillingPage } from './billing';

export const metadata = pageMetadata({
  title: 'Billing | OpenGen',
  description: 'Add prepaid OpenGen credit and review your workspace payment history.',
  path: '/billing',
  noindex: true,
});
export default function Page() {
  return <BillingPage />;
}
