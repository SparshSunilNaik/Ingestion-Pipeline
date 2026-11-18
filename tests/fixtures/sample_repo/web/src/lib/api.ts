export interface Item {
  name: string;
}

export async function fetchItems(base: string): Promise<Item[]> {
  const res = await fetch(`${base}/items`);
  return parseItems(await res.json());
}

export function parseItems(raw: unknown): Item[] {
  return Array.isArray(raw) ? (raw as Item[]) : [];
}
