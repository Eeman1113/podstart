import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'podstart',
  description:
    'Record a podcast with someone on the other side of the country. Both ends roll together, both ends record locally at full quality, and the synced mix is waiting when you stop.',
  applicationName: 'podstart',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'podstart' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled: pinching to read is an accessibility right, and
  // nothing in this layout breaks when it happens.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
