import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { data, format } = await request.json();

    const backendRes = await fetch('http://localhost:8000/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data, config: { format } }),
    });

    if (!backendRes.ok) {
      const errorData = await backendRes.json().catch(() => ({}));
      return NextResponse.json(errorData, { status: backendRes.status });
    }

    // Backend returns JSON: { file_content, filename, mime_type }
    const result = await backendRes.json();
    const { file_content, filename, mime_type } = result;

    return new Response(file_content, {
      status: 200,
      headers: {
        'Content-Type': mime_type,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Error proxying request' }, { status: 500 });
  }
}
