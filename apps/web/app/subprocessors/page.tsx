import { LegalReviewPage } from '../legal/review-page';
import { subprocessorsPolicy } from '../legal/policies';
import { legalPageMetadata, readWebLegalPublication } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return legalPageMetadata('subprocessors');
}

export default function SubprocessorsReviewPage() {
  return <LegalReviewPage policy={subprocessorsPolicy} publication={readWebLegalPublication()} />;
}
