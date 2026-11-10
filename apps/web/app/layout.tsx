import type { Metadata } from 'next';
import './globals.css';
import { JsonLd, SITE_DESCRIPTION, siteOrigin, siteStructuredData } from './seo';
import { PublicOriginProvider } from './public-origin';
import { LegalPresentationProvider } from './legal/presentation';
import { readWebLegalSurfacePresentation } from './legal/publication';

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  applicationName: 'OpenGen',
  title: 'OpenGen — image & video generation API providers',
  description: SITE_DESCRIPTION,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <JsonLd data={siteStructuredData()} />
        <PublicOriginProvider origin={siteOrigin()}>
          <LegalPresentationProvider presentation={readWebLegalSurfacePresentation()}>
            {children}
          </LegalPresentationProvider>
        </PublicOriginProvider>
      </body>
    </html>
  );
}
