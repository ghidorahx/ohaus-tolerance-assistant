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

const salesStarterMessage: Message = {
  id: "sales-welcome",
  role: "assistant",
  text: "Ask me about product compatibility, replacements, accessories, or lifecycle status across the OHAUS portfolio. The assistant is designed for every product series; Scout is simply the first verified dataset being loaded.",
};

const suggestedQuestions = [
  "What is the tolerance for STX622?",
  "What is the OCL for RC31P3?",
  "Which weight class does R71MHD3 use?",
  "What is tolerance vs. uncertainty?",
];

const salesSuggestedQuestions = [
  "Which replacement power adapter works with Scout?",
  "Is the Bluetooth accessory still available?",
  "Will the stacking cover fit SPX123?",
  "Will the stacking cover fit SPX223?",
];

function answerSalesQuestion(question: string): AnswerResult {
  const normalized = question.toLowerCase();

  if (normalized.includes("bluetooth")) {
    return {
      kind: "sales-guidance",
      text: "No. The Scout Bluetooth accessory is no longer available and is no longer supported.",
    };
  }

  if (normalized.includes("adapter") || normalized.includes("power supply") || normalized.includes("power cord")) {
    return {
      kind: "sales-guidance",
      text: "Use item 30330714. It is the only replacement power adapter currently offered for the Scout series.",
    };
  }

  if (
    (normalized.includes("cover") || normalized.includes("stacking")) &&
    (normalized.includes("spx123") || normalized.includes("spx223"))
  ) {
    return {
      kind: "sales-guidance",
      text: "No. SPX123 and SPX223 have draft shields, so the Scout stacking covers do not fit those models.",
    };
  }

  if (normalized.includes("tolerance") || normalized.includes("accuracy")) {
    return {
      kind: "sales-guidance",
      text: "Tolerance and accuracy guidance is handled through OHAUS's internal tolerance method; it is not listed in the Scout data sheet. Use the Tolerance Assistant tab for that calculation workflow.",
    };
  }

  if (normalized.includes("30253017")) {
    return {
      kind: "sales-guidance",
      text: "30253017 is the active item number in the current Scout sales reference.",
    };
  }

  return {
    kind: "sales-guidance",
    text: "The Sales Assistant is designed to support every OHAUS product series. Its current verified dataset begins with Scout, so today you can try asking about the replacement power adapter, Bluetooth availability, or stacking-cover compatibility for SPX123 and SPX223. Additional series will be added without changing this workflow.",
  };
}

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
  const [salesMessages, setSalesMessages] = useState<Message[]>([salesStarterMessage]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const knowledgeUrl = new URL("data/ohaus-knowledge.json", document.baseURI);
    fetch(knowledgeUrl)
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

  const isSalesMode = mode === "sales";
  const activeMessages = isSalesMode ? salesMessages : messages;
  const activeStarterMessage = isSalesMode ? salesStarterMessage : starterMessage;
  const activeSuggestions = isSalesMode ? salesSuggestedQuestions : suggestedQuestions;
  const isReady = isSalesMode || Boolean(data);

  const exchanges = useMemo(() => {
    const conversation = activeMessages.filter(
      (message) => message.id !== "welcome" && message.id !== "sales-welcome",
    );
    const grouped: Exchange[] = [];
    for (let index = 0; index < conversation.length; index += 2) {
      const user = conversation[index];
      const assistant = conversation[index + 1];
      if (user?.role === "user" && assistant?.role === "assistant") {
        grouped.push({ id: assistant.id, user, assistant });
      }
    }
    return grouped.reverse();
  }, [activeMessages]);

  function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || (!isSalesMode && !data)) return;
    const timestamp = Date.now();
    const result = isSalesMode
      ? answerSalesQuestion(trimmed)
      : answerQuestion(trimmed, data as KnowledgeBase) as AnswerResult;
    const updateMessages = isSalesMode ? setSalesMessages : setMessages;
    updateMessages((current) => [
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
    if (isSalesMode) {
      setSalesMessages([salesStarterMessage]);
    } else {
      setMessages([starterMessage]);
    }
    setInput("");
    inputRef.current?.focus();
  }

  function switchMode(nextMode: AssistantMode) {
    setMode(nextMode);
    setInput("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <main className={`app-shell ${isSalesMode ? "sales-mode" : "tolerance-mode"}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div>
            <p className="eyebrow">{isSalesMode ? "Internal sales support" : "Service reference"}</p>
            <h1>{isSalesMode ? "Sales Assistant" : "Tolerance Assistant"}</h1>
          </div>
        </div>

        <nav className="mode-switcher" aria-label="Assistant mode">
          <button
            className={!isSalesMode ? "active" : ""}
            onClick={() => switchMode("tolerance")}
            aria-pressed={!isSalesMode}
          >
            <span className="mode-icon" aria-hidden="true">±</span>
            Tolerance
          </button>
          <button
            className={isSalesMode ? "active" : ""}
            onClick={() => switchMode("sales")}
            aria-pressed={isSalesMode}
          >
            <span className="mode-icon" aria-hidden="true">S</span>
            Sales
          </button>
        </nav>

        <div className="header-actions">
          <button className="clear-button" onClick={clearConversation}>Clear chat</button>
          <div className="header-status">
            <span className="status-dot" aria-hidden="true" />
            {isSalesMode ? "Sales pilot" : "Verified local data"}
          </div>
        </div>
      </header>

      <section className="workspace">
        <aside className="side-panel">
          <div className="side-visual">
            {isSalesMode ? (
              <div className="sales-visual" aria-label="OHAUS portfolio sales assistant">
                <span>OHAUS</span>
                <strong>SALES</strong>
                <small>PRODUCT PORTFOLIO SUPPORT</small>
                <div className="scale-silhouette" aria-hidden="true">
                  <i />
                  <b>0.00</b>
                </div>
              </div>
            ) : (
              <img
                src="./og.png"
                width={1730}
                height={909}
                alt="Precision scale and tolerance reference illustration"
              />
            )}
          </div>

          <div className="data-card">
            <p className="panel-label">{isSalesMode ? "Current verified dataset" : "Knowledge base"}</p>
            <strong>{isSalesMode ? "Scout" : totalRecords.toLocaleString()}</strong>
            <span>{isSalesMode ? "First product line" : "model records"}</span>
            <div className="data-meter"><span /></div>
            <p className="data-note">{isSalesMode ? "Portfolio-wide assistant · More series to follow" : "August 2026 master reference"}</p>
          </div>

          <div className="side-section">
            <p className="panel-label">{isSalesMode ? "Try a current question" : "Try a question"}</p>
            {activeSuggestions.map((question) => (
              <button
                key={question}
                className="prompt-link"
                onClick={() => submitQuestion(question)}
                disabled={!isReady}
              >
                <span>↗</span>{question}
              </button>
            ))}
          </div>

          <div className="coverage-card">
            <p className="panel-label">Answer coverage</p>
            <div className="coverage-tags">
              {(isSalesMode
                ? ["All product series", "Compatibility", "Accessories", "Replacements", "Lifecycle"]
                : [
                    "Tolerance", "OCL", "Repeatability", "Linearity", "Readability",
                    "Capacity", "Weight class", "Temperature",
                  ]
              ).map((item) => <span key={item}>{item}</span>)}
            </div>
          </div>

          <div className="privacy-note">
            <span aria-hidden="true">●</span>
            <div>
              <strong>Runs in your browser</strong>
              <p>{isSalesMode ? "This pilot uses confirmed local product rules." : "No question or model data leaves this app."}</p>
            </div>
          </div>
        </aside>

        <section className="chat-panel">
          <div className="chat-heading">
            <div>
              <p className="eyebrow">{isSalesMode ? "Product sales lookup" : "Service lookup"}</p>
              <h2>{isSalesMode ? "Ask an OHAUS sales question" : "Ask a tolerance question"}</h2>
              <p>{isSalesMode ? "Compatibility and replacement guidance designed for every OHAUS product family." : "Deterministic answers from structured, source-linked records."}</p>
            </div>
            <div className="heading-side">
              <span className={`data-ready ${loadError ? "error" : ""}`}>
                {isSalesMode ? "Scout data loaded" : loading ? "Loading data…" : loadError ? "Data unavailable" : "Data ready"}
              </span>
            </div>
          </div>

          <form className="ask-form" onSubmit={onSubmit}>
            <label htmlFor="question">{isSalesMode ? "Sales question" : "Service question"}</label>
            <div className="input-row">
              <input
                ref={inputRef}
                id="question"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={isSalesMode ? "Example: Which power adapter works with Scout?" : "Example: What is the tolerance for STX622?"}
                autoComplete="off"
                disabled={!isReady}
              />
              <button type="submit" disabled={!isReady || !input.trim()} aria-label="Ask question">Ask <span>→</span></button>
            </div>
            <div className="form-footnote">
              <p>{isSalesMode ? "Portfolio-wide assistant · Scout data loaded first · broader AI coverage next." : "Use an exact model number for specifications. Every answer stays tied to its source record."}</p>
              <span>{isSalesMode ? "Internal sales pilot" : "Pilot owner · T. Delacruz"}</span>
            </div>
          </form>

          <div className="message-list" aria-live="polite">
            {exchanges.length === 0 ? (
              <div className="welcome-state">
                <MessageBubble message={activeStarterMessage} onFollowUp={submitQuestion} />
              </div>
            ) : (
              <>
                <section className="latest-exchange" aria-label="Latest answer">
                  <div className="exchange-label"><span>Latest response</span></div>
                  <MessageBubble message={exchanges[0].user} onFollowUp={submitQuestion} />
                  <MessageBubble message={exchanges[0].assistant} onFollowUp={submitQuestion} />
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
                          <MessageBubble message={exchange.assistant} onFollowUp={submitQuestion} />
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
    </main>
  );
}
