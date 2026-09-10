import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { SITE_URL, REPO } from '@/lib/links';
import { loadMessages, type Locale, LocaleProvider } from '@/lib/i18n';
import '../globals.css';

const locale: Locale = 'en';

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
  title: {
    default: title,
    template: '%s | StarDust',
  },
  description,
  applicationName: 'StarDust',
  category: 'technology',
  keywords: [
    'MySQL',
    'PHP',
    'dynamic fields',
    'EAV alternative',
    'multi-tenant',
    'vertical schema partitioning',
    'schemaless',
    'indexed JSON',
    'database engine',
  ],
  authors: [{ name: 'Konstelasi Teknologi Internasional', url: 'https://konstelasi.co.id' }],
  creator: 'Konstelasi Teknologi Internasional',
  publisher: 'Konstelasi Teknologi Internasional',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  alternates: {
    canonical: '/',
    languages: {
      en: '/',
      id: '/id/',
    },
  },
  openGraph: {
    title,
    description,
    type: 'website',
    url: '/',
    siteName: 'StarDust',
    locale: 'en_US',
    images: [
      {
        url: '/icon.svg',
        width: 1200,
        height: 630,
        alt: 'StarDust Logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StarDust — dynamic fields at native SQL index speed',
    description,
    images: ['/icon.svg'],
  },
};

export const viewport: Viewport = {
  themeColor: '#07060c',
  colorScheme: 'dark',
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'StarDust',
  operatingSystem: 'Cross-platform (MySQL 8.0.13+, PHP 8.1+)',
  applicationCategory: 'DeveloperApplication',
  description,
  url: SITE_URL,
  author: {
    '@type': 'Organization',
    name: 'Konstelasi Teknologi Internasional',
    url: 'https://konstelasi.co.id',
  },
  programmingLanguage: 'PHP',
  softwareRequirements: 'PHP 8.1+, MySQL 8.0.13+',
  codeRepository: REPO,
  license: 'https://opensource.org/licenses/MIT',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const messages = await loadMessages(locale);

  return (
    <html lang="en" className={poppins.variable}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      {/*
        Extensions inject attributes onto <body> before React hydrates —
        Grammarly's `data-gr-ext-installed`, ClickUp's class — which React
        reports as a hydration mismatch against server HTML that cannot
        possibly have carried them. Suppression is one level deep, so this
        covers the attributes without hiding a real mismatch in `children`.
      */}
      <body suppressHydrationWarning>
        <LocaleProvider locale={locale} messages={messages}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}

