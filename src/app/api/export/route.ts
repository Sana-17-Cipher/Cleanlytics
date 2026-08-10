import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { data, format } = await request.json();

    const backendRes = await fetch('http://localhost:8005/api/export', {
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

    const result = await backendRes.json();
    const { file_content, filename, mime_type, encoding } = result;

    if (encoding === 'base64') {
      // Decode base64 to binary buffer (for XLSX)
      const binaryString = atob(file_content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      return new Response(bytes.buffer, {
        status: 200,
        headers: {
          'Content-Type': mime_type,
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // Text content (CSV, JSON)
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
