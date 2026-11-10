import { renderWebLegalPublicationManifestResponse } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function GET() {
  return renderWebLegalPublicationManifestResponse();
}
