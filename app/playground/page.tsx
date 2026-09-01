import type { Metadata } from 'next';
import Playground from '@/components/playground/Playground';

/**
 * This file stays a server component purely so it can export `metadata` — Next
 * only reads that from a server module, which is why the entire interactive
 * tree starts one level down in `components/playground/Playground.tsx`.
 *
 * `canonical` and `openGraph.url` are overridden rather than inherited: the
 * root layout sets both to `/`, and a second page inheriting them would
 * declare itself a duplicate of the landing page.
 */

const title = 'StarDust playground — the whole lifecycle, in your browser';
const description =
  'Define a model, write rows, pause the daemons mid-backfill and watch a filter be ' +
  'rejected for a reason you caused. A hand-written simulation of the StarDust engine.';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/playground/' },
  openGraph: {
    title,
    description,
    type: 'website',
    url: '/playground/',
    siteName: 'StarDust',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image', title: 'StarDust playground', description },
};

export default function PlaygroundPage() {
  return <Playground />;
}
