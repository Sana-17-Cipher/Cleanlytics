import { NextResponse } from 'next/server';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; relId: string }> }
) {
  try {
    const { id, relId } = await params;
    const body = await request.json();
    const backendRes = await fetch(`http://localhost:8005/api/projects/${id}/relationships/${relId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await backendRes.json();
    return NextResponse.json(data, { status: backendRes.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Error updating relationship' }, { status: 500 });
  }
}
