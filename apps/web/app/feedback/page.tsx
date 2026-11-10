import { pageMetadata } from '../seo';
import { FeedbackForm } from './report';
export const metadata = pageMetadata({
  title: 'Private feedback | OpenGen',
  description: 'Review and send private product feedback or request a model or regional route.',
  path: '/feedback',
  noindex: true,
});
export default function FeedbackPage() {
  return <FeedbackForm />;
}
