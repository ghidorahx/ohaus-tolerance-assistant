"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { GoogleSearchSuggestions } from "./SalesAssistant";
import { googleAnswerLines, safeGoogleSourceUrl } from "../lib/google-direct-format.mjs";

type Result = {
  question: string;
  answer: string;
  model: string;
  thinking: string;
  status: "answered" | "needs_clarification" | "not_verified";
  elapsed_ms: number;
  sources: { title: string; url: string }[];
  suggestions: string[];
  citations: { start: number; end: number; source_index: number }[];
  attempts: number;
};

function GoogleAnswerContent({ result }: { result: Result }) {
  const lines = googleAnswerLines(result.answer, result.sources, result.citations);
  function partText(text: string, key: string): ReactNode[] {
    return text.split(/(\b\d{6,8}\b)/g).filter(Boolean).map((part, index) => /^\d{6,8}$/.test(part)
      ? <strong className="sales-part-number" key={`${key}-${index}`}>{part}</strong> : part);
  }
  function lineContent(line: typeof lines[number], key: string): ReactNode[] {
    const content: ReactNode[] = [];
    let position = 0;
    for (const citation of line.citations) {
      content.push(...partText(line.text.slice(position, citation.offset), `${key}-${position}`));
      position = citation.offset;
      const source = result.sources[citation.source_index];
      const url = safeGoogleSourceUrl(source?.url);
      if (url) content.push(<sup key={`${key}-cite-${position}-${citation.source_index}`} style={{ marginLeft: 3, fontSize: ".72em", fontWeight: 700 }}><a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Source ${citation.source_index + 1}: ${source.title}`} title={source.title}>[{citation.source_index + 1}]</a></sup>);
    }
    content.push(...partText(line.text.slice(position), `${key}-${position}`));
    return content;
  }
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const key = `line-${index}`;
    if (line.kind === "heading") blocks.push(<h3 key={key}>{lineContent(line, key)}</h3>);
    else if (line.kind.endsWith("-item")) {
      const items: ReactNode[] = [];
      const kind = line.kind;
      do {
        items.push(<li key={`line-${index}`}>{lineContent(lines[index], `line-${index}`)}</li>);
        index++;
      } while (index < lines.length && lines[index].kind === kind);
      index--;
      blocks.push(kind === "ordered-item" ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    } else blocks.push(<p key={key}>{lineContent(line, key)}</p>);
  }
  return <div className="sales-answer-copy">{blocks}</div>;
}

export default function GoogleDirectAssistant() {
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const question = input.trim();
    const accessCode = code.trim() || window.localStorage.getItem("sales-pilot-access-code") || "";
    if (!accessCode) { setNeedsCode(true); return; }
    setBusy(true); setError(""); setStopped(false);
    const abort = new AbortController();
    pending.current = abort;
    try {
      const response = await fetch(new URL("api/google-direct", document.baseURI), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Pilot-Access-Code": accessCode },
        body: JSON.stringify({ question, context: results.slice(-4).map(({ question, answer }) => ({ question, answer })) }), signal: abort.signal,
      });
      const payload = await response.json();
      if (abort.signal.aborted || pending.current !== abort) return;
      if (response.status === 401) setNeedsCode(true);
      if (!response.ok) throw new Error(payload.error || "The search could not complete.");
      setResults((previous) => [...previous, { ...payload, question }]);
      setInput(""); setNeedsCode(false);
      window.localStorage.setItem("sales-pilot-access-code", accessCode);
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "The search could not complete.");
    } finally {
      if (pending.current === abort) { setBusy(false); pending.current = null; }
    }
  }

  function stopSearch() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setStopped(true);
  }

  const latest = results.at(-1);
  function renderAnswer(result: Result) {
    return <>
      <GoogleAnswerContent result={result} />
      <GoogleSearchSuggestions items={result.suggestions} />
    </>;
  }

  return <section className="sales-chat-panel" aria-label="Testing">
    <form className="sales-composer" onSubmit={ask}>
      <div className="sales-composer-heading"><span /><button type="button" disabled={busy} onClick={() => { setResults([]); setError(""); setStopped(false); }}>Clear conversation</button></div>
      {needsCode && <input className="sales-access-code" type="password" aria-label="Team access code" placeholder="Team access code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />}
      <div className="sales-composer-row">
        <textarea id="google-test-question" aria-label="Testing question" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={3} maxLength={1600} disabled={busy} placeholder="Ask a question…" />
        {busy ? <button type="button" onClick={stopSearch}>Stop</button> : <button type="submit" disabled={!input.trim()}>Testing</button>}
      </div>
      {stopped && <p role="status">Stopped.</p>}
      {error && <p className="sales-error" role="alert">{error}</p>}
    </form>
    <div className="sales-conversation" aria-live="polite">
      {busy && <div className="sales-thinking" role="status"><span aria-hidden="true" />Thinking…</div>}
      {latest && <article className="sales-assistant-message"><span className="sales-message-avatar" aria-hidden="true">AI</span><div><p className="eyebrow">{latest.question}</p>{renderAnswer(latest)}</div></article>}
      {results.slice(0, -1).reverse().map((result, index) => <details className="sales-reference-panel" key={index}><summary>{result.question}</summary><div className="sales-reference-content">{renderAnswer(result)}</div></details>)}
    </div>
  </section>;
}
