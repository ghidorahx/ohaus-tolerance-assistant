"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { answerFormatting, answerQuestion } from "@/lib/answer-engine.mjs";
import SalesAssistant from "./SalesAssistant";

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

type Exchange = {
  id: string;
  user: Message;
  assistant: Message;
};

type AssistantMode = "tolerance" | "sales";

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

function MessageBubble({
  message,
  onFollowUp,
}: {
  message: Message;
  onFollowUp: (question: string) => void;
}) {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar" aria-hidden="true">{message.role === "assistant" ? "O" : "Y"}</div>
      <div className="message-content">
        <p>{message.text}</p>

        {message.result?.options && (
          <div className="choice-list">
            {message.result.options.map((option) => (
              <button key={option.id} onClick={() => onFollowUp(option.question)}>
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
  );
}

export default function Home() {
  const [mode, setMode] = useState<AssistantMode>("tolerance");
  const [data, setData] = useState<KnowledgeBase | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([starterMessage]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const knowledgeUrl = new URL("data/ohaus-knowledge.json", document.baseURI);
    fetch(knowledgeUrl)
      .then((response) => {
        if (!response.ok) throw new Error("Knowledge base unavailable");
        return response.json() as Promise<KnowledgeBase>;
      })
      .then((knowledge) => setData(knowledge))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const totalRecords = useMemo(
    () => (data ? data.meta.currentRecords + data.meta.legacyRecords : 746),
    [data],
  );

  const isSalesMode = mode === "sales";
  const isProductMode = isSalesMode;

  const exchanges = useMemo(() => {
    const conversation = messages.filter((message) => message.id !== "welcome");
    const grouped: Exchange[] = [];
    for (let index = 0; index < conversation.length; index += 2) {
      const user = conversation[index];
      const assistant = conversation[index + 1];
      if (user?.role === "user" && assistant?.role === "assistant") {
        grouped.push({ id: assistant.id, user, assistant });
      }
    }
    return grouped.reverse();
  }, [messages]);

  function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || !data) return;
    const exchangeId = crypto.randomUUID();
    const result = answerQuestion(trimmed, data) as AnswerResult;

    setMessages((current) => [
      ...current,
      { id: `user-${exchangeId}`, role: "user", text: trimmed },
      { id: `assistant-${exchangeId}`, role: "assistant", text: result.text, result },
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

  function switchMode(nextMode: AssistantMode) {
    setMode(nextMode);
  }

  return (
    <main className={`app-shell ${isProductMode ? "sales-mode" : "tolerance-mode"}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div>
            <p className="eyebrow">{isProductMode ? "Product intelligence" : "Service reference"}</p>
            <h1>{isSalesMode ? "Ask" : "Tolerance Assistant"}</h1>
          </div>
        </div>

        <nav className="mode-switcher" aria-label="Assistant mode">
          <button
            className={mode === "tolerance" ? "active" : ""}
            onClick={() => switchMode("tolerance")}
            aria-pressed={mode === "tolerance"}
          >
            <span className="mode-icon" aria-hidden="true">±</span>
            Tolerance
          </button>
          <button
            className={isSalesMode ? "active" : ""}
            onClick={() => switchMode("sales")}
            aria-pressed={isSalesMode}
          >
            <span className="mode-icon" aria-hidden="true">?</span>
            Ask
          </button>
        </nav>

        <div className="header-actions">
          {mode === "tolerance" && <button className="clear-button" onClick={clearConversation}>Clear chat</button>}
          <div className="header-status">
            <span className="status-dot" aria-hidden="true" />
            {isProductMode ? "Workbook grounded" : "Verified local data"}
          </div>
        </div>
      </header>

      <div className="mode-surface sales-mode-surface" hidden={!isSalesMode}>
        <SalesAssistant />
      </div>
      <div className="mode-surface tolerance-mode-surface" hidden={mode !== "tolerance"}>
        <section className="workspace">
        <aside className="side-panel">
          <div className="side-visual">
            <img
              src="./og.png"
              width={1730}
              height={909}
              alt="Precision scale and tolerance reference illustration"
            />
          </div>

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
            <div className="heading-side">
              <span className={`data-ready ${loadError ? "error" : ""}`}>
                {loading ? "Loading data…" : loadError ? "Data unavailable" : "Data ready"}
              </span>
            </div>
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
              <button type="submit" disabled={!data || !input.trim()} aria-label="Ask question">
                Ask <span>→</span>
              </button>
            </div>
            <div className="form-footnote">
              <p>Use an exact model number for specifications. Every answer stays tied to its source record.</p>
              <span>Pilot owner · T. Delacruz</span>
            </div>
          </form>

          <div className="message-list" aria-live="polite">
            {exchanges.length === 0 ? (
              <div className="welcome-state">
                <MessageBubble message={starterMessage} onFollowUp={submitQuestion} />
              </div>
            ) : (
              <>
                <section className="latest-exchange" aria-label="Latest answer">
                  <div className="exchange-label"><span>Latest response</span></div>
                  <MessageBubble message={exchanges[0].user} onFollowUp={submitQuestion} />
                  <MessageBubble
                    message={exchanges[0].assistant}
                    onFollowUp={submitQuestion}
                  />
                </section>

                {exchanges.length > 1 && (
                  <section className="history-list" aria-label="Previous answers">
                    <div className="history-heading">
                      <span>Previous answers</span>
                      <strong>{exchanges.length - 1}</strong>
                    </div>
                    {exchanges.slice(1).map((exchange) => (
                      <details className="history-item" key={exchange.id}>
                        <summary>
                          <span className="history-copy">
                            <strong>{exchange.user.text}</strong>
                            <small>{exchange.assistant.result?.factValue ?? exchange.assistant.text}</small>
                          </span>
                          <span className="history-toggle" aria-hidden="true">+</span>
                        </summary>
                        <div className="history-content">
                          <MessageBubble message={exchange.user} onFollowUp={submitQuestion} />
                          <MessageBubble
                            message={exchange.assistant}
                            onFollowUp={submitQuestion}
                          />
                        </div>
                      </details>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>

        </section>
        </section>
      </div>
    </main>
  );
}
