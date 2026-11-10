import { LegalReviewPage } from '../legal/review-page';
import { refundsPolicy } from '../legal/policies';
import { legalPageMetadata, readWebLegalPublication } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return legalPageMetadata('refunds');
}

export default function RefundsReviewPage() {
  return <LegalReviewPage policy={refundsPolicy} publication={readWebLegalPublication()} />;
}
