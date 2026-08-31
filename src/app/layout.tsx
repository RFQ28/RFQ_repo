import type { Metadata } from 'next'
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

// Instrument Sans for everything you read, JetBrains Mono for everything you
// count. Numbers only line up into scannable columns if they are all mono.
const instrumentSans = Instrument_Sans({ variable: '--font-instrument-sans', subsets: ['latin'] })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Quote Desk',
  description: 'RFQ to draft quote, for electrical distributors.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  )
}
