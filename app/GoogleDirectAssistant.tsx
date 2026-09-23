"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { GoogleSearchSuggestions, SalesAnswerContent } from "./SalesAssistant";

type Result = { question: string; answer: string; model: string; elapsed_ms: number; sources: { title: string; url: string }[]; suggestions: string[] };

export default function GoogleDirectAssistant() {
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    const question = input.trim();
    const accessCode = code.trim() || window.localStorage.getItem("sales-pilot-access-code") || "";
    if (!accessCode) { setNeedsCode(true); return; }
    setBusy(true); setError("");
    const abort = new AbortController();
    pending.current = abort;
    try {
      const response = await fetch(new URL("api/google-direct", document.baseURI), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Pilot-Access-Code": accessCode },
        body: JSON.stringify({ question, context: results.slice(-4).map(({ question, answer }) => ({ question, answer })) }), signal: abort.signal,
      });
      const payload = await response.json();
      if (response.status === 401) setNeedsCode(true);
      if (!response.ok) throw new Error(payload.error || "The search could not complete.");
      setResults((previous) => [...previous, { ...payload, question }]);
      setInput(""); setNeedsCode(false);
      window.localStorage.setItem("sales-pilot-access-code", accessCode);
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "The search could not complete.");
    } finally { setBusy(false); pending.current = null; }
  }

  const latest = results.at(-1);
  function renderAnswer(result: Result) {
    const partNumbers = result.answer.match(/\b\d{6,8}\b/g) ?? [];
    return <>
      <SalesAnswerContent value={result.answer} partNumbers={partNumbers} />
      <GoogleSearchSuggestions items={result.suggestions} />
      <details className="sales-reference-panel answered">
        <summary><span>Sources &amp; details</span><small>{result.sources.length} sources · {(result.elapsed_ms / 1000).toFixed(1)}s</small></summary>
        <div className="sales-reference-content">
          <div className="sales-web-sources"><ol>{result.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ol></div>
          <div className="sales-answer-foot">{result.model} · minimal thinking · Google Search · no catalog lookup</div>
        </div>
      </details>
    </>;
  }

  return <section className="sales-chat-panel" aria-label="Google AI Test">
    <form className="sales-composer" onSubmit={ask}>
      <div className="sales-composer-heading"><label htmlFor="google-test-question">Google AI Test</label><button type="button" disabled={busy} onClick={() => { setResults([]); setError(""); }}>Clear conversation</button></div>
      <p>Ask public product questions directly with Gemini and Google Search. This test does not use the master Excel file.</p>
      {needsCode && <input className="sales-access-code" type="password" aria-label="Team access code" placeholder="Team access code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />}
      <div className="sales-composer-row">
        <textarea id="google-test-question" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={3} maxLength={1600} disabled={busy} placeholder="Example: What is the battery life of an OHAUS CR221?" />
        <button type="submit" disabled={busy || !input.trim()}>{busy ? "Searching…" : "Ask Google"}</button>
      </div>
      <div className="sales-composer-foot"><small>Gemini 3.5 Flash-Lite · minimal thinking · Public questions only</small></div>
      {error && <p className="sales-error" role="alert">{error}</p>}
    </form>
    <div className="sales-conversation" aria-live="polite">
      {busy && <div className="sales-thinking" role="status"><span aria-hidden="true" />Searching Google and checking sources…</div>}
      {latest && <article className="sales-assistant-message"><span className="sales-message-avatar" aria-hidden="true">AI</span><div><p className="eyebrow">{latest.question}</p>{renderAnswer(latest)}</div></article>}
      {results.slice(0, -1).reverse().map((result, index) => <details className="sales-reference-panel" key={index}><summary>{result.question}</summary><div className="sales-reference-content">{renderAnswer(result)}</div></details>)}
    </div>
  </section>;
}
