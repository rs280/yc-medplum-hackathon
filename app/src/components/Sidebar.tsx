'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, LayoutDashboard, Plug, Receipt, Smartphone, Sparkles, Users } from 'lucide-react';

/**
 * Primary navigation, mapped to the patient journey the agents automate:
 * intake (Patients) → visit & follow-up (Schedule) → insurance (Claims) →
 * ops overview (Dashboard).
 */

const NAV = [
  { href: '/dashboard', label: 'Overview', sub: 'your AI back office', icon: LayoutDashboard },
  { href: '/patients', label: 'Patients', sub: 'intake & journey', icon: Users },
  { href: '/schedule', label: 'Schedule', sub: 'visits & follow-ups', icon: CalendarDays },
  { href: '/claims', label: 'Claims', sub: 'insurance & billing', icon: Receipt },
  { href: '/patient', label: 'Patient view', sub: 'what Maria sees', icon: Smartphone },
  { href: '/integrations', label: 'Integrations', sub: 'connected services', icon: Plug },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <nav className="sidebar" aria-label="Primary">
      <Link href="/dashboard" className="sidebar-brand">
        <span className="brand-mark">
          <Sparkles size={15} strokeWidth={2.2} aria-hidden />
        </span>
        <div>
          <div className="brand-name">Back Office</div>
          <div className="brand-sub">clinic copilot</div>
        </div>
      </Link>
      <div className="sidebar-nav">
        {NAV.map(({ href, label, sub, icon: Icon }) => {
          // Exact match, plus a `/` guard for future detail routes — a prefix
          // test alone lights up both /patient and /patients.
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} className={`sidebar-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
              <Icon size={17} strokeWidth={2} aria-hidden />
              <span className="sidebar-item-text">
                <span className="sidebar-item-label">{label}</span>
                <span className="sidebar-item-sub">{sub}</span>
              </span>
            </Link>
          );
        })}
      </div>
      <div className="sidebar-foot">One pipeline: redact → retrieve → reason → act → learn</div>
    </nav>
  );
}
