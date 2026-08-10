import { NextResponse } from 'next/server';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const backendRes = await fetch(`http://localhost:8005/api/projects/${id}/detect-relationships`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await backendRes.json();
    return NextResponse.json(data, { status: backendRes.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Error detecting relationships' }, { status: 500 });
  }
}
