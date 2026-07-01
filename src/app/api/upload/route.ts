import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    
    const backendRes = await fetch('http://localhost:8000/api/upload', {
      method: 'POST',
      body: formData,
    });
    
    const data = await backendRes.json();
    return NextResponse.json(data, { status: backendRes.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Error proxying request' }, { status: 500 });
  }
}
