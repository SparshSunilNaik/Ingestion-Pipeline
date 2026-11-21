import { proxyToBackend } from "@/lib/proxy";

// Every /api/* request is forwarded to the local backend (see lib/proxy.ts).
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  return proxyToBackend(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
