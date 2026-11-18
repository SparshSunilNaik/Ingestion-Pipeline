import { formatName, Formatter, shout } from "./lib";
import Default from "./widget";

export function render(v: string): string {
  const f = new Formatter();
  return shout(formatName(f.run(v))) + Default();
}
