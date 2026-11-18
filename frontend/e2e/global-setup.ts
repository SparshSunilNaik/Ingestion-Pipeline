import { execFileSync } from "node:child_process";
import path from "node:path";

/** Seeds the test backend's data directory with fixture repositories through the real ingestion pipeline. */
export default async function globalSetup() {
  const uv = (process.env.IP_UV_CMD ?? "uv").split(" ");
  const backend = path.join(__dirname, "..", "..", "backend");
  execFileSync(uv[0], [...uv.slice(1), "run", "python", "-m", "app.devtools", "seed-e2e"], {
    cwd: backend,
    stdio: "inherit",
    env: { ...process.env, IP_ENVIRONMENT: "test", IP_DATA_DIR: path.join(__dirname, ".data"), IP_LOG_LEVEL: "WARNING", UV_LINK_MODE: "copy" },
  });
}
