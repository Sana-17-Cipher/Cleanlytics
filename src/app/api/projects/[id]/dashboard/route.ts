import { NextResponse } from 'next/server';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authHeader = request.headers.get('authorization');
    const { id } = await params;

    const backendRes = await fetch(`http://localhost:8000/api/projects/${id}/dashboard`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    const data = await backendRes.json();
    if (!backendRes.ok) return NextResponse.json(data, { status: backendRes.status });

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to fetch dashboard' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authHeader = request.headers.get('authorization');
    const { id } = await params;
    const body = await request.json();

    const backendRes = await fetch(`http://localhost:8000/api/projects/${id}/dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });

    const data = await backendRes.json();
    if (!backendRes.ok) return NextResponse.json(data, { status: backendRes.status });

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to save dashboard' }, { status: 500 });
  }
}
