import { formatName, Formatter, shout } from "./lib";
import Default from "./widget";

export function render(v: string): string {
  const f = new Formatter();
  return shout(formatName(f.run(v))) + Default();
}

const shared = new Formatter();

export const quick = (v: string): string => shared.run(v);
