import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { SITE_URL, REPO } from '@/lib/links';
import { loadMessages, type Locale, LocaleProvider } from '@/lib/i18n';
import '../globals.css';

const locale: Locale = 'id';

// Mirrors app/(en)/layout.tsx exactly — each locale root layout loads its
// own copy since Next.js requires font loaders to run in the file that
// renders the <html> tag they apply to.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-poppins',
  display: 'swap',
});

const description =
  'Field dinamis tanpa skema, diquery dengan kecepatan indeks SQL asli — tidak ada cluster ' +
  'pencarian terpisah, tidak ada rawa join EAV. Engine PHP netral terhadap framework untuk MySQL 8.';

const title = 'StarDust — field dinamis dengan kecepatan indeks SQL asli';

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
    'field dinamis',
    'alternatif EAV',
    'multi-tenant',
    'vertical schema partitioning',
    'tanpa skema',
    'JSON terindeks',
    'mesin database',
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
    canonical: '/id/',
    languages: {
      en: '/',
      id: '/id/',
    },
  },
  openGraph: {
    title,
    description,
    type: 'website',
    url: '/id/',
    siteName: 'StarDust',
    locale: 'id_ID',
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
    title,
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
  url: `${SITE_URL}/id/`,
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

export default async function IdLayout({ children }: { children: React.ReactNode }) {
  const messages = await loadMessages(locale);

  return (
    <html lang="id" className={poppins.variable}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body suppressHydrationWarning>
        <LocaleProvider locale={locale} messages={messages}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
