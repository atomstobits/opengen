import { pageMetadata } from '../seo';
import { Dashboard } from '../dashboard/workspace';

export const metadata = pageMetadata({
  title: 'Your OpenGen account | OpenGen',
  description:
    'Get started, review generation activity and manage your OpenGen workspace and team.',
  path: '/app',
  noindex: true,
});

export default function AccountPage() {
  return <Dashboard appMode />;
}
