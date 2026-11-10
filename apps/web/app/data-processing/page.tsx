import { LegalReviewPage } from '../legal/review-page';
import { dataProcessingPolicy } from '../legal/policies';
import { legalPageMetadata, readWebLegalPublication } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function generateMetadata() {
  return legalPageMetadata('data-processing');
}

export default function DataProcessingReviewPage() {
  return <LegalReviewPage policy={dataProcessingPolicy} publication={readWebLegalPublication()} />;
}
