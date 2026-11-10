import { pageMetadata } from '../seo';
import { Dashboard } from './workspace';

export const metadata = pageMetadata({
  title: 'Your workspace | OpenGen',
  description: 'Manage your OpenGen generations, balance and usage ledger.',
  path: '/dashboard',
  noindex: true,
});
export default function DashboardPage() {
  return <Dashboard />;
}
