// Shared SSE framing for the provider and browser. Never expose provider events
// directly: only the decoded answer draft and the final hydrated result travel out.
export async function* readEvents(body) {
  if (!body) throw new Error("Missing response stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        if (frame.length > 262144) throw new Error("Stream event too large.");
        buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      if (buffer.length > 262144) throw new Error("Stream event too large.");
      if (done) {
        if (buffer.trim()) throw new Error("Incomplete stream event.");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Decode only an initial top-level answer property; if the provider chooses a
// different property order we safely wait for the final result instead.
export function answerPrefix(raw) {
  const match = /^\s*\{\s*"answer"\s*:\s*"/.exec(raw);
  if (!match) return "";
  let text = "";
  for (let i = match[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') break;
    if (char !== "\\") { text += char; continue; }
    const escape = raw[++i];
    if (!escape) break;
    if (escape === "u") {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      text += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (!(escape in escapes)) break;
      text += escapes[escape];
    }
  }
  return text.replace(/[\uD800-\uDBFF]$/, "");
}

/** @param {(draft: (text: string) => void, signal: AbortSignal) => Promise<Response>} run
 * @param {AbortSignal} signal */
export function salesStreamResponse(run, signal) {
  const abort = new AbortController();
  let streamController;
  const onAbort = () => { abort.abort(); streamController?.error(new Error("Request cancelled.")); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) abort.abort();
  const encoder = new TextEncoder();
  let queued = 0;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      let previous = "";
      const emit = (type, payload) => {
        abort.signal.throwIfAborted();
        const bytes = encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
        queued += bytes.length;
        if (queued > 2 * 1024 * 1024) throw new Error("Answer stream too large.");
        controller.enqueue(bytes);
      };
      void (async () => {
        try {
          emit("status", { message: "Searching catalog" });
          const response = await run((text) => {
            emit("draft", { text: text.slice(previous.length) });
            previous = text;
          }, abort.signal);
          const payload = await response.json();
          emit(response.ok ? "complete" : "error", { ...payload, status: response.status });
        } catch {
          if (!abort.signal.aborted) emit("error", { error: "The answer stream was interrupted. Please try again.", status: 502 });
        } finally {
          signal.removeEventListener("abort", onAbort);
          if (!abort.signal.aborted) controller.close();
        }
      })().catch((error) => { controller.error(error); abort.abort(); });
    },
    cancel() { abort.abort(); signal.removeEventListener("abort", onAbort); },
  });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  } });
}
