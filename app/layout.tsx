import type { Metadata, Viewport } from 'next';
import { SITE_URL } from '@/lib/links';
import './globals.css';

const description =
  'Schemaless dynamic fields, queried at native SQL index speed — no separate ' +
  'search cluster, no EAV join swamp. A framework-neutral PHP engine for MySQL 8.';

const title = 'StarDust — dynamic fields at native SQL index speed';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  applicationName: 'StarDust',
  keywords: [
    'MySQL', 'PHP', 'dynamic fields', 'EAV alternative', 'multi-tenant',
    'vertical schema partitioning', 'schemaless', 'indexed JSON',
  ],
  authors: [{ name: 'Konstelasi Teknologi Internasional' }],
  alternates: { canonical: '/' },
  openGraph: {
    title,
    description,
    type: 'website',
    url: '/',
    siteName: 'StarDust',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image', title: 'StarDust', description },
};

export const viewport: Viewport = {
  themeColor: '#06070c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
