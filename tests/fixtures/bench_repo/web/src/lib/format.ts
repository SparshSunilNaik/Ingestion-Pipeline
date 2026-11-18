export function formatName(n: string): string {
  return n.trim();
}
export class Formatter {
  run(v: string): string { return this.clean(v); }
  clean(v: string): string { return formatName(v); }
}
