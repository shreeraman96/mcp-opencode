// Fake Grok process for lifecycle tests. It creates a grandchild in the same
// process group, records the pid, then stays alive until the group is killed.
import { spawn } from "node:child_process";
import fs from "node:fs";

const outFile = process.argv[2];
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});
fs.writeFileSync(outFile, String(grandchild.pid));
setInterval(() => {}, 1000);
