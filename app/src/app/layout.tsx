import type { Metadata } from 'next';
import { Figtree } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const figtree = Figtree({ subsets: ['latin'], display: 'swap', variable: '--font-figtree' });

export const metadata: Metadata = {
  title: 'Back Office — Clinic Copilot',
  description:
    'Cursor for medical clinics: a voice + chat copilot driving autonomous agents across intake, scheduling, discharge follow-up, and insurance.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={figtree.variable}>{children}</body>
    </html>
  );
}
