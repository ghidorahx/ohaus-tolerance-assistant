"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { answerFormatting, answerQuestion } from "@/lib/answer-engine.mjs";

type Measure = {
  value: number | null;
  unit: string | null;
  d?: number | null;
  secondaryValue?: number | null;
  secondaryUnit?: string | null;
};

type ModelRecord = {
  id: string;
  lifecycle: "current" | "legacy";
  series: string;
  tableTitle: string;
  modelGroup: string;
  aliases: string[];
  capacity?: Measure;
  readability?: Measure;
  repeatability: Measure;
  linearity: Measure;
  ocl: Measure;
  tolerance?: Measure;
  calibration?: { astm: string | null; oiml: string | null };
  source: { manual: string; page: number };
  qa?: { status: "ok" | "review"; messages: string[] };
};

type KnowledgeBase = {
  meta: {
    documentDate: string;
    currentRecords: number;
    legacyRecords: number;
    knownQaItems: number;
  };
  current: ModelRecord[];
  legacy: ModelRecord[];
  temperatureSpecs: unknown[];
  guidance: unknown[];
};

type AnswerResult = {
  kind: string;
  text: string;
  factLabel?: string;
  factValue?: string;
  record?: ModelRecord;
  source?: { manual: string; page: number };
  temperature?: {
    model_group: string;
    heater_technology: string;
    temperature_readability_c: number;
    adjustment_mass_value: number;
    adjustment_mass_unit: string;
  };
  options?: Array<{
    id: string;
    label: string;
    question: string;
    source: { manual: string; page: number };
  }>;
};

type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
  result?: AnswerResult;
};

const starterMessage: Message = {
  id: "welcome",
  role: "assistant",
  text: "Ask me about a model's tolerance, readability, repeatability, linearity, off-center load, capacity, calibration-weight class, or moisture-analyzer temperature specification.",
};

const suggestedQuestions = [
  "What is the tolerance for STX622?",
  "What is the OCL for RC31P3?",
  "Which weight class does R71MHD3 use?",
  "What is tolerance vs. uncertainty?",
];

function measureText(measure: Measure | undefined, signed = false) {
  return answerFormatting.measureText(measure, signed);
}

export default function Home() {
  const [data, setData] = useState<KnowledgeBase | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([starterMessage]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/data/ohaus-knowledge.json")
      .then((response) => {
        if (!response.ok) throw new Error("Knowledge base unavailable");
        return response.json();
      })
      .then((knowledge: KnowledgeBase) => setData(knowledge))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const totalRecords = useMemo(
    () => (data ? data.meta.currentRecords + data.meta.legacyRecords : 746),
    [data],
  );

  function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || !data) return;
    const timestamp = Date.now();
    const result = answerQuestion(trimmed, data) as AnswerResult;
    setMessages((current) => [
      ...current,
      { id: `user-${timestamp}`, role: "user", text: trimmed },
      { id: `assistant-${timestamp}`, role: "assistant", text: result.text, result },
    ]);
    setInput("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submitQuestion(input);
  }

  function clearConversation() {
    setMessages([starterMessage]);
    setInput("");
    inputRef.current?.focus();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div>
            <p className="eyebrow">OHAUS service reference</p>
            <h1>Tolerance Assistant</h1>
          </div>
        </div>
        <div className="header-actions">
          <button className="clear-button" onClick={clearConversation}>Clear chat</button>
          <div className="header-status">
            <span className="status-dot" aria-hidden="true" />
            Verified local data
          </div>
        </div>
      </header>

      <section className="workspace">
        <aside className="side-panel">
          <div className="data-card">
            <p className="panel-label">Knowledge base</p>
            <strong>{totalRecords.toLocaleString()}</strong>
            <span>model records</span>
            <div className="data-meter"><span /></div>
            <p className="data-note">August 2026 master reference</p>
          </div>

          <div className="side-section">
            <p className="panel-label">Try a question</p>
            {suggestedQuestions.map((question) => (
              <button
                key={question}
                className="prompt-link"
                onClick={() => submitQuestion(question)}
                disabled={!data}
              >
                <span>↗</span>{question}
              </button>
            ))}
          </div>

          <div className="coverage-card">
            <p className="panel-label">Answer coverage</p>
            <div className="coverage-tags">
              {[
                "Tolerance", "OCL", "Repeatability", "Linearity", "Readability",
                "Capacity", "Weight class", "Temperature",
              ].map((item) => <span key={item}>{item}</span>)}
            </div>
          </div>

          <div className="privacy-note">
            <span aria-hidden="true">●</span>
            <div>
              <strong>Runs in your browser</strong>
              <p>No question or model data leaves this app.</p>
            </div>
          </div>
        </aside>

        <section className="chat-panel">
          <div className="chat-heading">
            <div>
              <p className="eyebrow">Service lookup</p>
              <h2>Ask a tolerance question</h2>
              <p>Deterministic answers from structured, source-linked records.</p>
            </div>
            <span className={`data-ready ${loadError ? "error" : ""}`}>
              {loading ? "Loading data…" : loadError ? "Data unavailable" : "Data ready"}
            </span>
          </div>

          <div className="message-list" aria-live="polite">
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="avatar" aria-hidden="true">{message.role === "assistant" ? "O" : "Y"}</div>
                <div className="message-content">
                  <p>{message.text}</p>

                  {message.result?.options && (
                    <div className="choice-list">
                      {message.result.options.map((option) => (
                        <button key={option.id} onClick={() => submitQuestion(option.question)}>
                          <span>{option.label}</span>
                          <small>Page {option.source.page} · {option.source.manual}</small>
                        </button>
                      ))}
                    </div>
                  )}

                  {message.result?.record && (
                    <div className="answer-card">
                      <div className="answer-card-head">
                        <div>
                          <span>{message.result.record.series}</span>
                          <h3>{message.result.record.modelGroup}</h3>
                        </div>
                        <div className="chip-row">
                          <span className="lifecycle-chip">{message.result.record.lifecycle}</span>
                          <span className={`qa-chip ${message.result.record.qa?.status ?? "ok"}`}>
                            {message.result.record.qa?.status === "review" ? "Source review" : "Verified"}
                          </span>
                        </div>
                      </div>

                      {message.result.factValue && (
                        <div className="primary-fact">
                          <span>{message.result.factLabel}</span>
                          <strong>{message.result.factValue}</strong>
                        </div>
                      )}

                      <div className="spec-grid">
                        <div><span>Readability</span><strong>{answerFormatting.readabilityText(message.result.record)}</strong></div>
                        <div><span>Repeatability</span><strong>{measureText(message.result.record.repeatability, true)}</strong></div>
                        <div><span>Linearity</span><strong>{measureText(message.result.record.linearity, true)}</strong></div>
                        <div><span>Off-center load</span><strong>{measureText(message.result.record.ocl, true)}</strong></div>
                      </div>

                      {message.result.record.qa?.messages?.length ? (
                        <div className="qa-note">
                          <strong>Source QA note</strong>
                          {message.result.record.qa.messages.map((note) => <p key={note}>{note}</p>)}
                        </div>
                      ) : null}

                      <div className="source-line">
                        Source: {message.result.record.source.manual} · Master reference page {message.result.record.source.page}
                      </div>
                    </div>
                  )}

                  {message.result?.temperature && (
                    <div className="answer-card compact-card">
                      <div className="spec-grid">
                        <div><span>Heater</span><strong>{message.result.temperature.heater_technology}</strong></div>
                        <div><span>Temperature readability</span><strong>{message.result.temperature.temperature_readability_c} °C</strong></div>
                        <div><span>Adjustment mass</span><strong>{message.result.temperature.adjustment_mass_value} {message.result.temperature.adjustment_mass_unit}</strong></div>
                      </div>
                      <div className="source-line">Source: Master Reference · Page {message.result.source?.page}</div>
                    </div>
                  )}

                  {message.result?.kind === "guidance" && message.result.source && (
                    <div className="guidance-source">Source: Master Reference guidance · Page {message.result.source.page}</div>
                  )}
                </div>
              </article>
            ))}
          </div>

          <form className="ask-form" onSubmit={onSubmit}>
            <label htmlFor="question">Service question</label>
            <div className="input-row">
              <input
                ref={inputRef}
                id="question"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Example: What is the tolerance for STX622?"
                autoComplete="off"
                disabled={!data}
              />
              <button type="submit" disabled={!data || !input.trim()} aria-label="Ask question">Ask <span>→</span></button>
            </div>
            <p>Use an exact model number for specifications. Every answer stays tied to its source record.</p>
          </form>
        </section>
      </section>
    </main>
  );
}
