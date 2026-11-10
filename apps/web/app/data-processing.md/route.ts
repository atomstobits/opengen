import { renderWebLegalMarkdownResponse } from '../legal/publication';

export const dynamic = 'force-dynamic';

export function GET() {
  return renderWebLegalMarkdownResponse('data-processing');
}
