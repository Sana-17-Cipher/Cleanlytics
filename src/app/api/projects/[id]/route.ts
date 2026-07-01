import { NextResponse } from 'next/server';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authHeader = request.headers.get('authorization');
    const { id } = await params;

    const backendRes = await fetch(`http://localhost:8000/api/projects/${id}`, {
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
    return NextResponse.json({ error: error.message || 'Failed to fetch project' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authHeader = request.headers.get('authorization');
    const { id } = await params;

    const backendRes = await fetch(`http://localhost:8000/api/projects/${id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    const data = await backendRes.json();
    if (!backendRes.ok) return NextResponse.json(data, { status: backendRes.status });

    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to delete project' }, { status: 500 });
  }
}
