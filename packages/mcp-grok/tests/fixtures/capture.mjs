// Fake Grok process for argv/prompt-file and cleanup tests. The wrapper passes
// its generated argv after this fixture's prefix arguments.
import fs from "node:fs";

const recordFile = process.argv[2];
const args = process.argv.slice(3);
const promptIndex = args.indexOf("--prompt-file");
const promptFile = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const sessionFlag = args.includes("--resume") ? "--resume" : "--session-id";
const sessionIndex = args.indexOf(sessionFlag);
const sessionID = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : undefined;
const mode = args.includes("--always-approve")
  ? "always-approve"
  : args.includes("--permission-mode")
    ? args[args.indexOf("--permission-mode") + 1]
    : "none";

fs.writeFileSync(
  recordFile,
  JSON.stringify({
    args,
    promptFile,
    prompt,
    mode,
    permissions: promptFile ? (fs.statSync(promptFile).mode & 0o777).toString(8) : undefined,
  }),
);
process.stdout.write(`${JSON.stringify({ type: "thought", data: "secret reasoning" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "text", data: "captured" })}\n`);
process.stdout.write(
  `${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: sessionID })}\n`,
);
