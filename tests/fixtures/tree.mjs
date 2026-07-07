// Test fixture: spawns a grandchild (in the SAME process group as this
// script, i.e. without `detached`) and then hangs forever, simulating a
// long-running opencode CLI process with its own child processes. Writes the
// grandchild's pid to the file given as argv[2] so the test can verify the
// whole tree died after a group kill.
import { spawn } from "node:child_process";
import fs from "node:fs";

const outFile = process.argv[2];

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});

fs.writeFileSync(outFile, String(grandchild.pid));

// Keep this process alive until killed.
setInterval(() => {}, 1000);
