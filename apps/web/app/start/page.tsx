import { pageMetadata } from '../seo';
import { Welcome } from './welcome';
export const metadata = pageMetadata({
  title: 'Get started | OpenGen',
  description:
    'Create an OpenGen account, connect an agent or start creating images and video in your browser.',
  path: '/start',
  noindex: true,
});
export default function StartPage() {
  return <Welcome />;
}
