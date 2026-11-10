import { LegalReviewPage } from '../legal/review-page';
import { termsPolicy } from '../legal/policies';
import { legalPageMetadata, readWebLegalPublication } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return legalPageMetadata('terms');
}

export default function TermsReviewPage() {
  return <LegalReviewPage policy={termsPolicy} publication={readWebLegalPublication()} />;
}
