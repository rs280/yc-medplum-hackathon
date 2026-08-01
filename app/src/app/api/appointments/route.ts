import { NextResponse, type NextRequest } from 'next/server';
import {
  AppointmentError,
  bookAppointment,
  cancelAppointment,
  fulfilNextBooked,
  listCalendar,
  rescheduleAppointment,
  restoreAppointment,
  type BookingSource,
  type CalendarAppointment,
} from '@/lib/appointments.server';

/**
 * The ONE write boundary for the clinic calendar. The Schedule UI posts here
 * today; a Deepgram voice agent with function calling can post the identical
 * commands tomorrow, which is why this is a route handler rather than a server
 * action — two entry points onto one service would be a duplicate implementation.
 *
 * Business logic lives in lib/appointments.server.ts. This file only validates
 * at the edge and maps errors onto status codes.
 */

export type AppointmentCommand =
  | {
      action: 'book';
      patientId?: string;
      patientName?: string;
      startIso: string;
      minutes?: number;
      description?: string;
    }
  | { action: 'reschedule'; id?: string; handle?: string; startIso: string; minutes?: number }
  | { action: 'cancel'; id?: string; handle?: string; reason?: string }
  | { action: 'restore'; id?: string; handle?: string }
  | { action: 'fulfil'; id?: string; handle?: string; patientRef?: string };

export interface AppointmentOk {
  ok: true;
  appointment: CalendarAppointment | null;
  message: string;
  warning?: string;
}

export interface AppointmentFail {
  ok: false;
  error: { code: AppointmentError['code']; message: string; candidates?: CalendarAppointment[] };
}

const SOURCES: readonly string[] = ['discharge-agent', 'care-gap-agent', 'copilot', 'staff', 'voice-agent'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Validate at the edge; anything malformed is rejected, not coerced. */
function parseCommand(raw: unknown): AppointmentCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const action = str(body.action);
  switch (action) {
    case 'book': {
      const startIso = str(body.startIso);
      if (!startIso) return null;
      if (!str(body.patientId) && !str(body.patientName)) return null;
      return {
        action,
        patientId: str(body.patientId),
        patientName: str(body.patientName),
        startIso,
        minutes: num(body.minutes),
        description: str(body.description),
      };
    }
    case 'reschedule': {
      const startIso = str(body.startIso);
      if (!startIso) return null;
      if (!str(body.id) && !str(body.handle)) return null;
      return { action, id: str(body.id), handle: str(body.handle), startIso, minutes: num(body.minutes) };
    }
    case 'cancel':
      if (!str(body.id) && !str(body.handle)) return null;
      return { action, id: str(body.id), handle: str(body.handle), reason: str(body.reason) };
    case 'restore':
      if (!str(body.id) && !str(body.handle)) return null;
      return { action, id: str(body.id), handle: str(body.handle) };
    case 'fulfil':
      if (!str(body.patientRef)) return null;
      return { action, patientRef: str(body.patientRef) };
    default:
      return null;
  }
}

/** GET /api/appointments — the calendar, optionally windowed. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  try {
    const appointments = await listCalendar({
      fromIso: params.get('from') ?? undefined,
      toIso: params.get('to') ?? undefined,
      patientId: params.get('patientId') ?? undefined,
      patientName: params.get('patientName') ?? undefined,
      includeCancelled: params.get('includeCancelled') === 'true',
    });
    return NextResponse.json({ appointments });
  } catch (err) {
    console.error('[appointments] read failed:', err);
    return NextResponse.json({ error: 'Could not read the calendar.' }, { status: 500 });
  }
}

/** POST /api/appointments — book, reschedule, cancel, restore, or fulfil a visit. */
export async function POST(req: NextRequest): Promise<NextResponse<AppointmentOk | AppointmentFail>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Body is not JSON.' } },
      { status: 400 },
    );
  }

  const command = parseCommand(raw);
  if (!command) {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Unrecognised or incomplete command.' } },
      { status: 400 },
    );
  }

  // The caller may name itself, but only from the known set — never free text.
  const claimed = str((raw as Record<string, unknown>).source);
  const by: BookingSource = (SOURCES.includes(claimed ?? '') ? claimed : 'staff') as BookingSource;

  try {
    switch (command.action) {
      case 'book': {
        const r = await bookAppointment({ ...command, source: by });
        return NextResponse.json({ ok: true, appointment: r.appointment, message: r.summary, warning: r.warning });
      }
      case 'reschedule': {
        const r = await rescheduleAppointment({ ...command, by });
        return NextResponse.json({ ok: true, appointment: r.appointment, message: r.summary });
      }
      case 'cancel': {
        const r = await cancelAppointment({ ...command, by });
        return NextResponse.json({ ok: true, appointment: r.appointment, message: r.summary });
      }
      case 'restore': {
        const r = await restoreAppointment({ ...command, by });
        return NextResponse.json({ ok: true, appointment: r.appointment, message: r.summary });
      }
      case 'fulfil': {
        const row = await fulfilNextBooked(command.patientRef!);
        return NextResponse.json({
          ok: true,
          appointment: row ?? null,
          message: row ? `${row.handle} marked fulfilled.` : 'No booked visit to fulfil.',
        });
      }
    }
  } catch (err) {
    if (err instanceof AppointmentError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
      return NextResponse.json(
        { ok: false, error: { code: err.code, message: err.message, candidates: err.candidates } },
        { status },
      );
    }
    console.error('[appointments] write failed:', err);
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Could not complete that change.' } },
      { status: 500 },
    );
  }
}
