import { parseItems } from "../../../src/lib/api";

export async function GET() {
  return Response.json({ ok: parseItems([]).length === 0 });
}
