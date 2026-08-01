import { NextResponse, type NextRequest } from 'next/server';
import { regeneratePatientOverview } from '@/lib/patientChart.server';
import { PatientError, registerPatient, updateCoverage, updateDemographics } from '@/lib/patients.server';
import { recordVitals } from '@/lib/vitals.server';

/**
 * The ONE write boundary for a patient's record. The intake form and the chart
 * post here; the copilot reaches the identical functions through its tools, so
 * there is one implementation behind two entry points rather than two.
 *
 * Business logic lives in lib/patients.server.ts and lib/vitals.server.ts. This
 * file only validates at the edge and maps errors onto status codes.
 */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function statusFor(code: PatientError['code']): number {
  return code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400;
}

/** POST /api/patients — register, update demographics or coverage, record vitals, refresh the overview. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Body is not JSON.' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'Body is not an object.' }, { status: 400 });
  }

  const body = raw as Record<string, unknown>;
  // `register` stays the default so the intake form's older shape keeps working.
  const action = str(body.action) ?? 'register';
  const who = { patientId: str(body.patientId), patientName: str(body.patientName) };

  try {
    switch (action) {
      case 'register': {
        const name = str(body.name);
        const payer = str(body.payer);
        if (!name || !payer) {
          return NextResponse.json({ error: 'A name and an insurance company are required.' }, { status: 400 });
        }
        const result = await registerPatient({
          name,
          payer,
          birthDate: str(body.birthDate),
          gender: str(body.gender),
          phone: str(body.phone),
          memberId: str(body.memberId),
        });
        return NextResponse.json(result);
      }
      case 'update-demographics': {
        const result = await updateDemographics({
          ...who,
          name: str(body.name),
          sex: str(body.sex),
          birthDate: str(body.birthDate),
          phone: str(body.phone),
          email: str(body.email),
          addressLine: str(body.addressLine),
          city: str(body.city),
          state: str(body.state),
          postalCode: str(body.postalCode),
        });
        return NextResponse.json(result);
      }
      case 'update-coverage': {
        const result = await updateCoverage({
          ...who,
          payer: str(body.payer),
          memberId: str(body.memberId),
          groupNumber: str(body.groupNumber),
          status: str(body.status),
        });
        return NextResponse.json(result);
      }
      case 'record-vitals': {
        const result = await recordVitals({
          ...who,
          vitals: {
            heightCm: num(body.heightCm),
            heightIn: num(body.heightIn),
            weightKg: num(body.weightKg),
            weightLb: num(body.weightLb),
            systolic: num(body.systolic),
            diastolic: num(body.diastolic),
            heartRate: num(body.heartRate),
            observedAt: str(body.observedAt),
          },
        });
        return NextResponse.json({ summary: result.summary, written: result.written });
      }
      case 'regenerate-overview': {
        const patientId = str(body.patientId);
        if (!patientId) return NextResponse.json({ error: 'A patientId is required.' }, { status: 400 });
        const overview = await regeneratePatientOverview(patientId);
        if (!overview) return NextResponse.json({ error: 'No such patient.' }, { status: 404 });
        return NextResponse.json({ overview });
      }
      default:
        return NextResponse.json({ error: `Unrecognised action '${action}'.` }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof PatientError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: statusFor(err.code) });
    }
    console.error('[patients] write failed:', err);
    return NextResponse.json({ error: 'Could not complete that change.' }, { status: 500 });
  }
}
