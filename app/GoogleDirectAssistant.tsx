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
    const visibleSources = result.sources.map((source, index) => ({ ...source, index, url: safeGoogleSourceUrl(source.url) })).filter((source) => source.url);
    const statusText = result.status === "needs_clarification" ? "A quick clarification"
      : result.status === "not_verified" ? "Not yet verified in public sources" : "";
    return <>
      {statusText && <p className="sales-answer-foot">{statusText}</p>}
      <GoogleAnswerContent result={result} />
      <GoogleSearchSuggestions items={result.suggestions} />
      <details className="sales-reference-panel answered">
        <summary><span>{visibleSources.length ? "Sources & details" : "Response details"}</span><small>{visibleSources.length ? `${visibleSources.length} ${visibleSources.length === 1 ? "source" : "sources"} · ` : ""}{(result.elapsed_ms / 1000).toFixed(1)}s</small></summary>
        <div className="sales-reference-content">
          {visibleSources.length > 0 && <div className="sales-web-sources"><ol>{visibleSources.map((source) => <li key={source.index} value={source.index + 1}><a href={source.url!} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ol></div>}
          <div className="sales-answer-foot">{result.model} · {result.thinking || "low"} thinking · Google Search · no catalog lookup{result.attempts > 1 ? " · search refined once" : ""}</div>
        </div>
      </details>
    </>;
  }

  return <section className="sales-chat-panel" aria-label="Google AI Test">
    <form className="sales-composer" onSubmit={ask}>
      <div className="sales-composer-heading"><label htmlFor="google-test-question">Google AI Test</label><button type="button" disabled={busy} onClick={() => { setResults([]); setError(""); setStopped(false); }}>Clear conversation</button></div>
      <p>A Google-assisted experiment for public product questions, with follow-ups and cited sources. It does not use the master Excel file or Google.com’s AI Mode.</p>
      {needsCode && <input className="sales-access-code" type="password" aria-label="Team access code" placeholder="Team access code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />}
      <div className="sales-composer-row">
        <textarea id="google-test-question" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={3} maxLength={1600} disabled={busy} placeholder="Example: What is the battery life of an OHAUS CR221?" />
        {busy ? <button type="button" onClick={stopSearch}>Stop</button> : <button type="submit" disabled={!input.trim()}>Ask Google</button>}
      </div>
      <div className="sales-composer-foot"><small>Public questions only · Reply naturally to ask a follow-up</small></div>
      {stopped && <p role="status">Search stopped. Your question is ready to try again.</p>}
      {error && <p className="sales-error" role="alert">{error}</p>}
    </form>
    <div className="sales-conversation" aria-live="polite">
      {busy && <div className="sales-thinking" role="status"><span aria-hidden="true" />Searching Google and checking sources. Technical questions may take a little longer…</div>}
      {latest && <article className="sales-assistant-message"><span className="sales-message-avatar" aria-hidden="true">AI</span><div><p className="eyebrow">{latest.question}</p>{renderAnswer(latest)}</div></article>}
      {results.slice(0, -1).reverse().map((result, index) => <details className="sales-reference-panel" key={index}><summary>{result.question}</summary><div className="sales-reference-content">{renderAnswer(result)}</div></details>)}
    </div>
  </section>;
}
