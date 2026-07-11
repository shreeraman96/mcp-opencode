# Grok CLI observations

`streaming-json.jsonl` is a sanitized fixture captured from the authenticated
Grok Build CLI v0.2.93 with a harmless read-only prompt. The observed framing
was one JSON object per line: `thought` chunks, a `text` chunk, and an `end`
event containing `stopReason`, `sessionId`, and `requestId`.

Reasoning text, local paths, credentials, and the real UUIDs were removed or
replaced. The parser must ignore `thought` and any tool/unknown event and retain
only assistant `text`, the terminal stop reason, and the session ID.
