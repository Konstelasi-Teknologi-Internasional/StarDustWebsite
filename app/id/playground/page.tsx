import { type Metadata } from 'next';
import Playground from '@/components/playground/Playground';
import { SITE_URL } from '@/lib/links';
import { loadMessages, type Locale, LocaleProvider } from '@/lib/i18n';

const locale: Locale = 'id';

export const metadata: Metadata = {
  title: 'Playground | StarDust',
  description:
    'Playground interaktif untuk StarDust — jelajahi field dinamis, siklus hidup field, dan pencerminan database dengan simulasi langsung.',
  alternates: {
    canonical: '/id/playground/',
    languages: {
      en: '/playground/',
      id: '/id/playground/',
    },
  },
  openGraph: {
    title: 'Playground | StarDust',
    description:
      'Playground interaktif untuk StarDust — jelajahi field dinamis, siklus hidup field, dan pencerminan database dengan simulasi langsung.',
    url: '/id/playground/',
    locale: 'id_ID',
  },
};

export default async function IdPlayground() {
  const messages = await loadMessages(locale);

  return (
    <LocaleProvider locale={locale} messages={messages}>
      <Playground />
    </LocaleProvider>
  );
}
