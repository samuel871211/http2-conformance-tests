import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { join } from "path";

const testsDir = join(import.meta.dirname, "tests");
const fileNames = readdirSync(testsDir).filter((file) => file.endsWith(".ts"));
for (const fileName of fileNames) {
  const { status, stdout, stderr, signal } = spawnSync(
    process.execPath,
    ["--import", "tsx", join(testsDir, fileName)],
    { encoding: "utf8", timeout: 10000 },
  );
  if (status === 0) console.log(stdout);
  else console.log({ stderr, signal });
}
