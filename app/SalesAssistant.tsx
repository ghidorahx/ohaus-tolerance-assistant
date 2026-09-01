"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

type Evidence = {
  material_number: string;
  model_or_item: string;
  field: string;
  value: string;
  source_file: string;
};

type AnswerItem = {
  identifier: string;
  label: string;
  description: string;
};

type SalesAnswer = {
  answer: string;
  answer_items: AnswerItem[];
  status: "answered" | "needs_clarification" | "not_in_source" | "escalate";
  confidence: "high" | "medium" | "low";
  intent: string;
  materials: string[];
  evidence: Evidence[];
  unresolved_items: string[];
  follow_up_suggestions: string[];
  context_summary: string;
  escalation_reason: string | null;
  model: string;
  primary_model: string;
  fallback_used: boolean;
  reasoning_effort: string;
  reasoning_mode: string;
  output_token_cap: number;
  output_cap_reduced: boolean;
  catalog_checks: number;
  retrieval_strategy: string;
  vectorize_status: string;
  retrieval_documents_sent: number;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: SalesAnswer;
};

type Exchange = {
  id: string;
  user: Message;
  assistant: Message;
};

type Health = {
  api_configured: boolean;
  access_code_required: boolean;
  model: string;
  fallback_model: string;
  reasoning_effort: string;
  reasoning_mode: string;
  vectorize: {
    configured: boolean;
    index: string;
    namespace: string;
    embedding_model: string;
    source_documents: number;
    vector_records: number;
  };
  context: {
    max_verified_turns: number;
    approximate_character_budget: number;
    max_retrieval_documents: number;
    max_total_request_tokens: number;
    max_input_tokens: number;
    max_output_tokens: number;
  };
  catalog: {
    portable_products: number;
    portable_families: number;
    api_records: number;
    resolved_related_items: number;
    document_links: number;
    retrieval_documents: number;
    retrieval_status: string;
    source_file: string;
  };
};

type AskApiResponse = {
  answer?: SalesAnswer;
  code?: string;
  error?: string;
  retry_after_seconds?: number;
};

const suggestions = [
  "What are the capacity, readability, power, and battery life of CR221?",
  "Compare CR221 and CR5200 for capacity, readability, power, and dimensions.",
  "Which balances support at least 5 kg capacity and battery operation?",
  "Which accessories are listed for STX123?",
];

function buildContext(messages: Message[], maxTurns: number) {
  const turns = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user.role !== "user" || assistant.role !== "assistant" || !assistant.answer) continue;
    turns.push({
      question: user.text,
      answer: assistant.answer.answer,
      materials: assistant.answer.materials,
      contextSummary: assistant.answer.context_summary,
    });
    index += 1;
  }
  return turns.slice(-maxTurns);
}

function statusLabel(status: SalesAnswer["status"]) {
  if (status === "answered") return "Source verified";
  if (status === "needs_clarification") return "Clarification needed";
  if (status === "not_in_source") return "Not in catalog";
  return "Review needed";
}

function prettyField(field: string) {
  return field
    .replace(/^sales_content\.|^specifications\.|^additional_attributes\./, "")
    .replaceAll("_", " ")
    .replaceAll(".", " › ");
}

function titleCase(value: string | undefined, fallback: string) {
  const label = value || fallback;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type AnswerBlock = {
  type: "heading" | "paragraph" | "unordered-list" | "ordered-list";
  content: string[];
};

function parseAnswerBlocks(value: string) {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let list: AnswerBlock | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", content: [paragraph.join(" ")] });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  for (const rawLine of String(value ?? "").replace(/\\([*_`])/g, "$1").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", content: [heading[1]] });
      continue;
    }

    const unorderedItem = line.match(/^[-*\u2022]\s+(.+)$/);
    const orderedItem = line.match(/^\d+[.)]\s+(.+)$/);
    const item = unorderedItem?.[1] ?? orderedItem?.[1];
    if (item) {
      flushParagraph();
      const type = unorderedItem ? "unordered-list" : "ordered-list";
      if (list && list.type !== type) flushList();
      list ??= { type, content: [] };
      list.content.push(item);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightPartNumbers(value: string, keyPrefix: string, partNumbers: string[]): ReactNode[] {
  const knownParts = [...new Set(partNumbers.map(String).filter(Boolean))].sort((left, right) => right.length - left.length);
  const patterns = [...knownParts.map(escapePattern), "\\b\\d{8}\\b"];
  const matcher = new RegExp(`(${patterns.join("|")})`, "g");
  const knownPartSet = new Set(knownParts.map((partNumber) => partNumber.toLowerCase()));

  return value.split(matcher).filter(Boolean).map((part, index) => {
    const isPartNumber = /^\d{8}$/.test(part) || knownPartSet.has(part.toLowerCase());
    return isPartNumber
      ? <strong className="sales-part-number" key={`${keyPrefix}-part-${index}`}>{part}</strong>
      : part;
  });
}

function renderInlineAnswer(value: string, keyPrefix: string, partNumbers: string[]): ReactNode[] {
  return value.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`)/g).filter(Boolean).flatMap((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    return highlightPartNumbers(part, key, partNumbers);
  });
}

function SalesAnswerContent({ value, partNumbers }: { value: string; partNumbers: string[] }) {
  const blocks = parseAnswerBlocks(value);
  return (
    <div className="sales-answer-copy">
      {blocks.map((block, blockIndex) => {
        const key = `answer-block-${blockIndex}`;
        if (block.type === "heading") return <h3 key={key}>{renderInlineAnswer(block.content[0], key, partNumbers)}</h3>;
        if (block.type === "unordered-list") {
          return <ul key={key}>{block.content.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInlineAnswer(item, `${key}-${itemIndex}`, partNumbers)}</li>)}</ul>;
        }
        if (block.type === "ordered-list") {
          return <ol key={key}>{block.content.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInlineAnswer(item, `${key}-${itemIndex}`, partNumbers)}</li>)}</ol>;
        }
        return <p key={key}>{renderInlineAnswer(block.content[0], key, partNumbers)}</p>;
      })}
    </div>
  );
}

function SalesAnswerItems({ items, partNumbers }: { items: AnswerItem[]; partNumbers: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="sales-answer-items" aria-label="Referenced items">
      {items.map((item, index) => (
        <div key={`${item.identifier}-${index}`}>
          <strong>{item.identifier}</strong>
          <span aria-hidden="true">—</span>
          <p><b>{item.label}</b>{item.description ? ": " : ""}{renderInlineAnswer(item.description, `answer-item-${index}`, partNumbers)}</p>
        </div>
      ))}
    </div>
  );
}

export default function SalesAssistant() {
  const [health, setHealth] = useState<Health | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [rateLimitSeconds, setRateLimitSeconds] = useState(0);
  const [productKnowledgeCollapsed, setProductKnowledgeCollapsed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const savedCode = window.localStorage.getItem("sales-pilot-access-code") ?? "";
    const preferenceTimer = window.setTimeout(() => {
      setProductKnowledgeCollapsed(window.localStorage.getItem("sales-product-knowledge-collapsed") === "true");
    }, 0);
    const url = new URL("api/sales", document.baseURI);
    fetch(url, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Product knowledge service unavailable");
        return response.json() as Promise<Health>;
      })
      .then((payload) => {
        setAccessCode(savedCode);
        setHealth(payload);
        setNeedsCode(Boolean(payload.access_code_required && !savedCode));
      })
      .catch(() => setError("The local product knowledge service is unavailable."));
    return () => window.clearTimeout(preferenceTimer);
  }, []);

  useEffect(() => {
    if (rateLimitSeconds <= 0) return;
    const timer = window.setTimeout(() => setRateLimitSeconds((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [rateLimitSeconds]);

  const exchanges = useMemo(() => {
    const grouped: Exchange[] = [];
    for (let index = 0; index < messages.length; index += 2) {
      const user = messages[index];
      const assistant = messages[index + 1];
      if (user?.role === "user" && assistant?.role === "assistant") {
        grouped.push({ id: assistant.id, user, assistant });
      }
    }
    return grouped.reverse();
  }, [messages]);

  const context = useMemo(
    () => buildContext(messages, health?.context.max_verified_turns ?? 120),
    [health, messages],
  );
  const activeMaterials = useMemo(
    () => [...new Set(context.flatMap((turn) => turn.materials))].slice(-24),
    [context],
  );

  async function askQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || thinking || rateLimitSeconds > 0) return;

    const userMessage: Message = { id: `user-${crypto.randomUUID()}`, role: "user", text: trimmed };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setError(null);
    setThinking(true);

    try {
      const url = new URL("api/sales", document.baseURI);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessCode.trim() ? { "X-Pilot-Access-Code": accessCode.trim() } : {}),
        },
        body: JSON.stringify({ question: trimmed, context }),
      });
      const payload = await response.json().catch(() => ({})) as AskApiResponse;
      if (response.status === 401 && payload.code === "access_code_required") {
        setNeedsCode(true);
        throw new Error("Enter the team access code, then ask the question again.");
      }
      if (response.status === 429) {
        const retryHeader = Number(response.headers.get("Retry-After"));
        const retryAfter = Number(payload.retry_after_seconds);
        const cooldown = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : Number.isFinite(retryHeader) && retryHeader > 0
            ? retryHeader
            : 30;
        setRateLimitSeconds(Math.min(600, Math.max(1, Math.ceil(cooldown))));
        throw new Error(payload.error ?? `The assistant is rate limited. Try again in about ${Math.ceil(cooldown)} seconds.`);
      }
      if (!response.ok || !payload.answer) throw new Error(payload.error ?? "The assistant could not answer this question.");

      const answer = payload.answer as SalesAnswer;
      const assistantMessage: Message = {
        id: `assistant-${crypto.randomUUID()}`,
        role: "assistant",
        text: answer.answer,
        answer,
      };
      setMessages((current) => [...current, assistantMessage]);
      setRateLimitSeconds(0);
      setNeedsCode(false);
      if (accessCode.trim()) window.localStorage.setItem("sales-pilot-access-code", accessCode.trim());
    } catch (caught) {
      setMessages((current) => current.filter((message) => message.id !== userMessage.id));
      setError(caught instanceof Error ? caught.message : "The assistant could not answer this question.");
    } finally {
      setThinking(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    askQuestion(input);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion(input);
    }
  }

  function clearConversation() {
    setMessages([]);
    setError(null);
    setInput("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function toggleProductKnowledge() {
    setProductKnowledgeCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem("sales-product-knowledge-collapsed", String(next));
      return next;
    });
  }

  const ready = Boolean(health?.api_configured);
  const coolingDown = rateLimitSeconds > 0;
  const totalRequestTokens = Math.round((health?.context.max_total_request_tokens ?? 450_000) / 1_000);
  const inputTokens = Math.round((health?.context.max_input_tokens ?? 322_000) / 1_000);
  const outputTokens = Math.round((health?.context.max_output_tokens ?? 128_000) / 1_000);

  return (
    <section className={`sales-workspace ${productKnowledgeCollapsed ? "sales-rail-collapsed" : ""}`} aria-label="Ask assistant">
      <aside className="sales-rail">
        <div className="sales-rail-header">
          <div className="sales-agent-badge" aria-hidden="true">AI</div>
          <button
            className="sales-rail-toggle"
            type="button"
            onClick={toggleProductKnowledge}
            aria-expanded={!productKnowledgeCollapsed}
            aria-controls="sales-product-knowledge-details"
            aria-label={`${productKnowledgeCollapsed ? "Expand" : "Collapse"} product knowledge panel`}
            title={`${productKnowledgeCollapsed ? "Expand" : "Collapse"} product knowledge`}
          >
            <span aria-hidden="true">‹</span>
          </button>
        </div>

        <div id="sales-product-knowledge-details" className="sales-rail-body" hidden={productKnowledgeCollapsed}>
          <div>
            <p className="eyebrow">Workbook-grounded</p>
            <h2>Product knowledge</h2>
            <p>Answers are generated only after the relevant Excel-derived records are retrieved.</p>
          </div>

          <div className="sales-stat-grid">
            <div><strong>{health?.catalog.portable_products ?? 80}</strong><span>portable balances</span></div>
            <div><strong>{health?.catalog.portable_families ?? 7}</strong><span>product families</span></div>
            <div><strong>{health?.catalog.resolved_related_items ?? 91}</strong><span>linked items</span></div>
            <div><strong>{health?.catalog.document_links ?? 226}</strong><span>document links</span></div>
          </div>

          <div className="sales-coverage-card">
            <span>Reasoning configuration</span>
            <strong>GPT‑5.6 Sol · Medium · {titleCase(health?.reasoning_mode, "standard")}</strong>
            <small>Fixed medium reasoning · Terra fallback · {health?.catalog.retrieval_documents ?? 87} generated knowledge documents</small>
          </div>

          <div className="sales-memory-card">
            <span>Extended context</span>
            <strong>{health?.context.max_verified_turns ?? 120} verified turns</strong>
            <small>
              {totalRequestTokens}K total request budget · {inputTokens}K input reserve · {outputTokens}K output cap · up to {health?.context.max_retrieval_documents ?? 8} knowledge documents
            </small>
          </div>

          <footer>{health?.vectorize?.configured ? "Vectorize semantic retrieval" : "Local retrieval fallback"} · Ask pilot owner · T. Delacruz</footer>
        </div>
      </aside>

      <section className="sales-chat-panel" aria-label="Product questions">
        <form className="sales-composer" onSubmit={onSubmit}>
          <div className="sales-composer-heading">
            <label htmlFor="sales-question">Product question</label>
            <div className="sales-heading-actions">
            {messages.length > 0 && <button type="button" onClick={clearConversation}>Clear conversation</button>}
            <span className={`sales-ready ${!ready || coolingDown ? "waiting" : ""}`}>
              <i aria-hidden="true" />
              {coolingDown ? `Ready in ${rateLimitSeconds}s` : health ? ready ? "AI + catalog ready" : "API key needed" : "Checking connection"}
            </span>
            </div>
          </div>
          {needsCode && (
            <input
              className="sales-access-code"
              type="password"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="Team access code"
              autoComplete="off"
              aria-label="Team access code"
            />
          )}
          <div className="sales-composer-row">
            <textarea
              ref={inputRef}
              id="sales-question"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Example: Which portable balance has at least 5 kg capacity, 1 g readability, and battery power?"
              rows={3}
              maxLength={1_600}
              disabled={thinking || !ready || coolingDown}
            />
            <button type="submit" disabled={thinking || !ready || coolingDown || !input.trim()}>
              {thinking ? "Checking…" : "Ask"} <span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="sales-composer-foot">
            <small>Enter to send · Shift + Enter for a new line · Unsupported fields are reported, never invented.</small>
            {context.length > 0 && <small>{context.length} context turn{context.length === 1 ? "" : "s"} · {activeMaterials.length} active product{activeMaterials.length === 1 ? "" : "s"}</small>}
          </div>
          {error && <p className="sales-error" role="alert">{error}</p>}
        </form>

        <div className="sales-conversation" aria-live="polite">
          {thinking && (
            <div className="sales-thinking" role="status">
              <span aria-hidden="true" />
              Retrieving the relevant workbook records and verifying the answer…
            </div>
          )}

          {exchanges.length === 0 ? (
            <div className="sales-welcome-state">
              <div className="sales-welcome">
                <span className="sales-message-avatar" aria-hidden="true">AI</span>
                <div>
                  <strong>Product assistant</strong>
                  <p>I’ll identify the relevant records, verify the requested fields, and show exactly which catalog data supports the answer.</p>
                </div>
              </div>
              <div className="sales-suggestions">
                {suggestions.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => askQuestion(suggestion)} disabled={!ready || thinking || coolingDown}>
                    <span aria-hidden="true">↗</span>{suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <section className="sales-latest" aria-label="Latest product answer">
                <div className="sales-section-label"><span>Latest answer</span></div>
                <SalesExchange exchange={exchanges[0]} onFollowUp={askQuestion} disabled={thinking || coolingDown} showFollowUpField />
              </section>
              {exchanges.length > 1 && (
                <section className="sales-history" aria-label="Previous product answers">
                  <div className="sales-section-label"><span>Previous answers</span><strong>{exchanges.length - 1}</strong></div>
                  {exchanges.slice(1).map((exchange) => (
                    <details key={exchange.id}>
                      <summary>
                        <span><strong>{exchange.user.text}</strong><small>{exchange.assistant.answer?.materials.join(" · ") || "Catalog response"}</small></span>
                        <b aria-hidden="true">+</b>
                      </summary>
                      <SalesExchange exchange={exchange} onFollowUp={askQuestion} disabled={thinking || coolingDown} />
                    </details>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </section>
  );
}

function SalesExchange({
  exchange,
  onFollowUp,
  disabled,
  showFollowUpField = false,
}: {
  exchange: Exchange;
  onFollowUp: (question: string) => void;
  disabled: boolean;
  showFollowUpField?: boolean;
}) {
  const [followUp, setFollowUp] = useState("");
  const answer = exchange.assistant.answer;
  if (!answer) return null;
  const answerItems = Array.isArray(answer.answer_items) ? answer.answer_items : [];

  function submitFollowUp(event: FormEvent) {
    event.preventDefault();
    const question = followUp.trim();
    if (!question || disabled) return;
    setFollowUp("");
    onFollowUp(question);
  }

  return (
    <div className="sales-exchange">
      <article className="sales-user-message">
        <span aria-hidden="true">You</span>
        <p>{exchange.user.text}</p>
      </article>
      <article className="sales-assistant-message">
        <span className="sales-message-avatar" aria-hidden="true">AI</span>
        <div>
          <SalesAnswerContent value={answer.answer} partNumbers={answer.materials} />
          <SalesAnswerItems items={answerItems} partNumbers={answer.materials} />

          <details className={`sales-reference-panel ${answer.status}`}>
            <summary>
              <span>Sources &amp; details</span>
              <small>{answer.evidence.length > 0 ? `${answer.evidence.length} verified field${answer.evidence.length === 1 ? "" : "s"}` : statusLabel(answer.status)}</small>
              <b aria-hidden="true">+</b>
            </summary>
            <div className="sales-reference-content">
              <div className="sales-answer-meta">
                <span className={`sales-answer-status ${answer.status}`}>{statusLabel(answer.status)}</span>
                <span>{answer.confidence} confidence</span>
              </div>

              {answer.materials.length > 0 && (
                <div className="sales-materials">
                  <span>Matched material numbers</span>
                  <strong>{answer.materials.join(" · ")}</strong>
                </div>
              )}

              {answer.evidence.length > 0 && (
                <div className="sales-evidence">
                  <div className="sales-evidence-heading">
                    <span>Verified catalog evidence</span>
                    <small>{answer.evidence.length} field{answer.evidence.length === 1 ? "" : "s"}</small>
                  </div>
                  <div className="sales-evidence-grid">
                    {answer.evidence.map((item, index) => (
                      <div key={`${item.material_number}-${item.field}-${index}`}>
                        <span>{item.model_or_item} · {item.material_number}</span>
                        <small>{prettyField(item.field)}</small>
                        <strong>{item.value}</strong>
                        <em>{item.source_file}</em>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {answer.unresolved_items.length > 0 && (
                <div className="sales-review-note">
                  <strong>Needs source review</strong>
                  <p>{answer.unresolved_items.join(" · ")}</p>
                </div>
              )}

              {answer.escalation_reason && (
                <div className="sales-review-note">
                  <strong>Why additional information is needed</strong>
                  <p>{answer.escalation_reason}</p>
                </div>
              )}

              {answer.follow_up_suggestions.length > 0 && (
                <div className="sales-follow-ups">
                  {answer.follow_up_suggestions.map((question) => (
                    <button type="button" key={question} onClick={() => onFollowUp(question)} disabled={disabled}>{question}</button>
                  ))}
                </div>
              )}

              <div className="sales-answer-foot">
                <span>{answer.model}{answer.fallback_used ? " fallback" : ""} · {answer.reasoning_effort} reasoning · {answer.reasoning_mode} mode</span>
                <span>{answer.retrieval_strategy === "vectorize_hybrid" ? "Vectorize + catalog" : "Catalog retrieval"} · {answer.retrieval_documents_sent ?? 0} document{answer.retrieval_documents_sent === 1 ? "" : "s"}</span>
                <span>{answer.catalog_checks} catalog check{answer.catalog_checks === 1 ? "" : "s"}</span>
              </div>
            </div>
          </details>

          {showFollowUpField && (
            <form className="sales-inline-follow-up" onSubmit={submitFollowUp}>
              <label htmlFor={`follow-up-${exchange.id}`}>Need more information?</label>
              <div>
                <input
                  id={`follow-up-${exchange.id}`}
                  value={followUp}
                  onChange={(event) => setFollowUp(event.target.value)}
                  placeholder="Ask a follow-up about this answer…"
                  maxLength={1_600}
                  disabled={disabled}
                />
                <button type="submit" disabled={disabled || !followUp.trim()}>Follow up <span aria-hidden="true">→</span></button>
              </div>
            </form>
          )}

        </div>
      </article>
    </div>
  );
}
