import { LegalReviewPage } from '../legal/review-page';
import { privacyPolicy } from '../legal/policies';
import { legalPageMetadata, readWebLegalPublication } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return legalPageMetadata('privacy');
}

export default function PrivacyReviewPage() {
  return <LegalReviewPage policy={privacyPolicy} publication={readWebLegalPublication()} />;
}
