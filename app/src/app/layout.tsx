import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Autonomous Back Office — Copilot',
  description:
    'Voice + chat copilot for clinicians and front-desk staff, driving four FHIR-triggered agents: triage, appeal, discharge, prior auth.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
