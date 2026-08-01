'use client';

import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

/**
 * Front-desk intake without going through the copilot. Posts to the same
 * registerPatient() the copilot's tool calls, so the two can never drift.
 *
 * Every field is controlled state rather than an uncontrolled input: the page
 * refreshes every few seconds, and typed text must survive that.
 */

interface IntakeFields {
  name: string;
  birthDate: string;
  gender: string;
  phone: string;
  payer: string;
  memberId: string;
}

const EMPTY: IntakeFields = { name: '', birthDate: '', gender: '', phone: '', payer: '', memberId: '' };

export function NewPatientForm() {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [form, setForm] = useState<IntakeFields>(EMPTY);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (isOpen) nameRef.current?.focus();
  }, [isOpen]);

  const setField = (key: keyof IntakeFields, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const canSubmit = form.name.trim() !== '' && form.payer.trim() !== '';

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          name: form.name.trim(),
          payer: form.payer.trim(),
          // Empty optional fields go as undefined, never '', so the route's
          // typeof checks stay meaningful.
          birthDate: form.birthDate || undefined,
          gender: form.gender || undefined,
          phone: form.phone.trim() || undefined,
          memberId: form.memberId.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`registration failed: ${res.status}`);
      const { id } = (await res.json()) as { id: string };
      setForm(EMPTY);
      setIsOpen(false);
      // Opening the new chart IS the confirmation.
      startTransition(() => router.push(`/patients?p=${id}`, { scroll: false }));
    } catch (err) {
      console.error('[patients] registration failed:', err);
      setError("Couldn't register that patient.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`switch-chip${isOpen ? ' active' : ''}`}
        aria-expanded={isOpen}
        aria-controls="new-patient-form"
        onClick={() => setIsOpen((open) => !open)}
      >
        <UserPlus size={13} strokeWidth={2.2} aria-hidden /> New patient
      </button>

      {isOpen && (
        <form id="new-patient-form" className="intake-form" onSubmit={submit} aria-label="Register a new patient">
          <div className="intake-field">
            <label htmlFor="np-name">Full name</label>
            <input
              id="np-name"
              ref={nameRef}
              value={form.name}
              required
              autoComplete="off"
              onChange={(e) => setField('name', e.target.value)}
            />
          </div>
          <div className="intake-field">
            <label htmlFor="np-dob">Date of birth</label>
            <input
              id="np-dob"
              type="date"
              value={form.birthDate}
              onChange={(e) => setField('birthDate', e.target.value)}
            />
          </div>
          <div className="intake-field">
            <label htmlFor="np-sex">Sex</label>
            <select id="np-sex" value={form.gender} onChange={(e) => setField('gender', e.target.value)}>
              <option value="">Not recorded</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="intake-field">
            <label htmlFor="np-phone">Phone</label>
            <input id="np-phone" type="tel" value={form.phone} onChange={(e) => setField('phone', e.target.value)} />
          </div>
          <div className="intake-field">
            <label htmlFor="np-payer">Insurance</label>
            <input
              id="np-payer"
              value={form.payer}
              required
              placeholder="Aetna"
              autoComplete="off"
              onChange={(e) => setField('payer', e.target.value)}
            />
          </div>
          <div className="intake-field">
            <label htmlFor="np-member">Member ID</label>
            <input
              id="np-member"
              value={form.memberId}
              autoComplete="off"
              onChange={(e) => setField('memberId', e.target.value)}
            />
          </div>
          <div className="intake-foot">
            <button type="submit" className="intake-submit" disabled={!canSubmit || isSaving}>
              {isSaving ? 'Registering…' : 'Register & check eligibility'}
            </button>
            {error ? (
              <span className="attach-error">{error}</span>
            ) : (
              <span className="attach-note">Runs a 270/271 eligibility check, same as the copilot&apos;s intake.</span>
            )}
          </div>
        </form>
      )}
    </>
  );
}
