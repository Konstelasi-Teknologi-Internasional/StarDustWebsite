import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { SITE_URL } from '@/lib/links';
import './globals.css';

// Konstelasi's brand typeface — every text role in their Elementor kit is
// set to Poppins. Weights cover the 500–660 cluster this codebase's own
// font-weight declarations use (nearest-available matching handles the
// odd values like 560/620/660); the mono stack is untouched.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-poppins',
  display: 'swap',
});

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
  themeColor: '#07060c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={poppins.variable}>
      <body>{children}</body>
    </html>
  );
}
