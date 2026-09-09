const EXPLICIT_WEB_SEARCH_PATTERN = /\b(?:search|check|find)\b[^\n]{0,48}\b(?:google|web|online|internet)\b|\blook(?:\s+it)?\s+up\b[^\n]{0,32}\b(?:online|on\s+google|on\s+the\s+web)\b|\b(?:according\s+to|from)\b[^\n]{0,40}\b(?:google|the\s+web|an?\s+official\s+(?:site|website|page))\b/i;
const EXTERNAL_SOURCE_PATTERN = /\b(?:google|online|internet|official\s+(?:site|website|page)|manufacturer(?:'s)?\s+(?:site|website|page)|ohaus(?:'s)?\s+(?:site|website|page)|nist|osha|fda|usda|epa|iso|astm|ansi|usp|federal\s+register)\b/i;
const CURRENT_EXTERNAL_PATTERN = /\b(?:current|currently|latest|newest|recent|recently|today|this\s+(?:week|month|year)|updated?|202[4-9])\b/i;
const EXTERNAL_TOPIC_PATTERN = /\b(?:news|announcement|recall|regulation|regulatory|law|standard|guidance|requirement|certification|compliance|company|manufacturer|documentation|manual|product\s+page|press\s+release|discontinued|replacement\s+model|successor)\b/i;
const PRIVATE_COMMERCIAL_PATTERN = /\b(?:price|pricing|cost|msrp|how\s+much|quote|quotation|discount|deal|negotiated\s+terms|commercial\s+terms|contract(?:ual)?\s+terms|inventory|on\s+hand|in\s+stock|stock\s+(?:level|status)|backorder(?:ed)?|availability|(?:is|are)\s+(?:ohaus\s+)?(?=[a-z0-9._/-]*\d)[a-z0-9._/-]+\s+available|(?:is|are)\s+(?:(?:this|that|the|an?)\s+)?(?:balance|scale|product|model|item)\s+available|available\s+(?:now|today|to\s+ship|for\s+(?:delivery|purchase)|to\s+buy|in\s+stock)|lead\s*time|eta|delivery\s+(?:date|time)|ship(?:ping)?\s+(?:date|time)|customer\s+specific|(?:my|customer|sales|purchase)\s+order|order\s+(?:status|number|date)|can\s+i\s+order|restock|buy|purchase|when\s+can\s+i\s+get|what\s+we\s+charge|what\s+we\s+sell\s+it\s+for)\b/i;
const PRIVATE_RECORD_PATTERN = /\b(?:customer|account|invoice|purchase\s+order|sales\s+order|tracking\s+number|serial\s+number|contact\s+record|crm|dealer[-\s]?only)\b/i;
const CONFIDENTIAL_PATTERN = /\b(?:confidential|proprietary|non\s+public|not\s+public|internal(?:ly)?|employee\s+only|restricted|sensitive|nda|trade\s+secret|contract|agreement|(?:internal|customer|client)\s+(?:project|case)|case\s+number|project\s+code)\b/i;
const CREDENTIAL_PATTERN = /\b(?:access\s+code|pass\s*code|pass\s*word|pin|otp|api\s+key|client\s+secret|secret\s+key|bearer\s+token|session\s+token|auth(?:entication|orization)?\s+token|login\s+credential|team\s+code)\b/i;
const PERSONAL_DATA_PATTERN = /\b(?:personal|private)\s+(?:email|phone|address|contact)\b|\b(?:email|phone|mailing\s+address|home\s+address|contact\s+details|social\s+security|ssn)\b/i;
const EMAIL_PATTERN = /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i;
const PHONE_PATTERN = /(?:^|\D)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?:\D|$)/;
const OPAQUE_SECRET_PATTERN = /\b(?=[a-z0-9_-]{32,}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/i;
const URL_PATTERN = /\bhttps?:\/\/|\bwww\./i;
const CATALOG_IDENTIFIER_PATTERN = /\b(?:material|item|part|model|sku)(?:\s+(?:number|no\.?|#))?\s*[:#-]?\s*[a-z0-9-]*\d[a-z0-9-]*\b|\b\d{6,8}\b|\b(?=[a-z0-9-]{4,}\b)(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]+\b/i;
const CONTEXT_REFERENCE_PATTERN = /\b(?:it|that|this|those|them|same|above|previous|earlier|what\s+about)\b/i;
const WEB_COMMAND_WORD_PATTERN = /\b(?:search|check|find|look|google|web|online|internet|up|on|the|for|please|current|currently|latest|newest|recent|recently|today)\b/gi;
const MASTER_REQUEST_STRATEGIES = new Set([
  "exact",
  "none",
  "lexical",
  "semantic",
  "numeric",
  "hybrid_rrf",
  "catalog_scope",
]);
const SAFE_MATERIAL_NUMBER_PATTERN = /^\d{6,8}$/;

// Every fragment is fixed server text. Match functions never copy captures or
// user wording into the outbound Google query.
const AUTOMATIC_PUBLIC_FACETS = [
  { id: "warranty", pattern: /\bwarrant(?:y|ies|ed)|\bwarrantee\b/i, query: "public warranty policy and terms" },
  { id: "recall", pattern: /\b(?:recall|safety\s+notice|corrective\s+action)\b/i, query: "current recalls and safety notices" },
  { id: "documentation", pattern: /\b(?:manual|documentation|data\s*sheet|datasheet|user\s+guide|brochure)\b/i, query: "official manuals and product documentation" },
  { id: "calibration_certificate", pattern: /\b(?:calibration|traceab(?:le|ility))\s+(?:certificate|certification)|\bcertificate\s+of\s+calibration\b/i, query: "calibration certificates and traceability documentation" },
  { id: "product_status", pattern: /\b(?:discontinued|replacement\s+model|successor|end\s+of\s+life|eol)\b/i, query: "current product lifecycle and replacement information" },
  { id: "compliance", pattern: /\b(?:compliance|compliant|certification|certified|regulation|regulatory|standard|guidance|nist|osha|fda|usda|epa|iso|astm|ansi|usp|rohs|reach|legal\s+for\s+trade)\b/i, query: "compliance, certification, and legal-for-trade information" },
  { id: "company_history", pattern: /\b(?:founded|founder|history|established|began|started)\b/i, query: "company founding and history" },
  { id: "company_profile", pattern: /\b(?:headquarters|headquartered|located|location|owner|owned|parent\s+company|manufactures?|company\s+profile|about\s+ohaus|what\s+is\s+ohaus)\b/i, query: "company profile, ownership, and headquarters" },
  { id: "battery_runtime", pattern: /\b(?:battery\s+(?:life|runtime|run\s*time|duration)|hours?\s+on\s+(?:a\s+)?battery|batt(?:ery|ry)\s+hours?)\b/i, query: "battery runtime and expected operating time" },
  { id: "capacity", pattern: /\b(?:maximum\s+capacity|weighing\s+(?:capacity|range)|how\s+much\s+(?:can|will)\s+it\s+weigh|capacity)\b/i, exclude: /\bbattery\s+capacity\b/i, query: "weighing capacity and range" },
  { id: "readability", pattern: /\b(?:readability|displayed\s+increment|division|resolution|smallest\s+(?:weight|increment))\b/i, query: "readability, resolution, and display increments" },
  { id: "stabilization", pattern: /\b(?:stabili[sz]ation|settling|response)\s+(?:time|speed)|\btime\s+to\s+stabili[sz]e\b/i, query: "stabilization and response time" },
  { id: "repeatability", pattern: /\brepeatability\b/i, query: "repeatability specifications" },
  { id: "linearity", pattern: /\blinearity\b/i, query: "linearity specifications" },
  { id: "accuracy", pattern: /\b(?:accuracy|precision|uncertainty)\b/i, query: "accuracy and measurement uncertainty" },
  { id: "power", pattern: /\b(?:power\s+(?:source|supply|requirements?)|voltage|mains|ac\s+adapter|dc\s+input)\b/i, query: "power source and electrical requirements" },
  { id: "pan_size", pattern: /\b(?:pan|platform|weighing\s+surface)\s+(?:size|dimensions?)\b/i, query: "weighing pan or platform dimensions" },
  { id: "dimensions", pattern: /\b(?:overall\s+dimensions?|physical\s+dimensions?|dimensions?|dimentions?|demensions?|product\s+size)\b/i, exclude: /\b(?:pan|platform|weighing\s+surface|shipping|package|packaged)\s+(?:size|dimensions?)\b/i, query: "overall physical dimensions" },
  { id: "shipping_weight", pattern: /\b(?:shipping|gross|packaged?|package)\s+weight\b/i, query: "shipping or gross weight" },
  { id: "net_weight", pattern: /\b(?:net|product|unit)\s+weight\b|\bhow\s+much\s+does\s+it\s+weigh\b/i, exclude: /\b(?:shipping|gross|packaged?|package)\s+weight\b/i, query: "net product weight" },
  { id: "units", pattern: /\b(?:weighing|measurement|available|supported|display)\s+units?\b|\bunits?\s+(?:are\s+)?(?:available|supported|displayed)\b/i, query: "supported measurement units" },
  { id: "display", pattern: /\b(?:display|screen|lcd|led|backlight)\b/i, query: "display type and visibility features" },
  { id: "applications", pattern: /\b(?:application|mode|function)s?\b/i, query: "supported applications and operating modes" },
  { id: "construction", pattern: /\b(?:construction|housing|enclosure|housing\s+material|construction\s+material|made\s+of|stainless\s+steel)\b/i, query: "construction and enclosure materials" },
  { id: "environment", pattern: /\b(?:operating\s+condition|temperature|humidity|altitude|environment(?:al)?)\b/i, query: "operating environment limits" },
  { id: "ingress", pattern: /\b(?:ingress|ip\s*\d{2}|ip\s+rating|washdown|washable|water\s+resistan|dust\s+resistan|cleaning|autoclav)\w*\b/i, query: "ingress protection, washdown, and cleaning guidance" },
  { id: "interfaces", pattern: /\b(?:interface|connectivity|usb|rs\s*232|ethernet|bluetooth|wifi|wi\s*fi)\b/i, query: "data interfaces and connectivity" },
  { id: "included_accessories", pattern: /\b(?:included|comes?\s+with|in\s+the\s+box|supplied)\s+(?:accessor|item|equipment|part)s?\b/i, query: "included accessories and package contents" },
  { id: "compatibility", pattern: /\b(?:compatib(?:le|ility)|works?\s+with|fits?|supported\s+(?:model|rotor|vial)|rotor|sample\s+vial)\b/i, query: "public compatibility information" },
  { id: "accessories", pattern: /\b(?:accessor|optional\s+equipment|add\s*on|spare\s+part|replacement\s+part)s?\b/i, query: "official accessories and replacement parts" },
  { id: "test_weight", pattern: /\b(?:test|calibration)\s+weight\b/i, query: "recommended test or calibration weights" },
  { id: "measurement_range", pattern: /\b(?:measurement|measuring|ph|conductivity|temperature|speed)\s+(?:range|limits?)\b/i, query: "supported measurement ranges" },
  { id: "speed", pattern: /\b(?:maximum|min(?:imum)?|top|operating)\s+speed\b|\b(?:rpm|revolutions?\s+per\s+minute)\b/i, query: "operating speed specifications" },
  { id: "technical", pattern: /\b(?:technical\s+(?:information|details|specifications?)|product\s+specifications?)\b/i, query: "general technical product specifications" },
];

function normalizeForPolicy(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[-_./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sensitiveReason(text) {
  const raw = String(text ?? "");
  if (EMAIL_PATTERN.test(raw) || PHONE_PATTERN.test(raw)) return "personal_data";
  const normalized = normalizeForPolicy(text);
  if (PRIVATE_COMMERCIAL_PATTERN.test(normalized)) return "private_commercial_data";
  if (PRIVATE_RECORD_PATTERN.test(normalized)) return "private_record_data";
  if (CONFIDENTIAL_PATTERN.test(normalized)) return "confidential_data";
  if (CREDENTIAL_PATTERN.test(normalized) || OPAQUE_SECRET_PATTERN.test(normalized)) return "credential_data";
  if (PERSONAL_DATA_PATTERN.test(normalized)) return "personal_data";
  return null;
}

function contextContainsSensitiveData(sessionContext) {
  if (!Array.isArray(sessionContext)) return false;
  return sessionContext.slice(-12).some((turn) => {
    if (!turn || typeof turn !== "object") return false;
    const text = [turn.question, turn.answer, turn.contextSummary, turn.summary]
      .filter((value) => typeof value === "string")
      .map((value) => value.slice(0, 1_200))
      .join(" ");
    return Boolean(sensitiveReason(text));
  });
}

function isDemonstrablySelfContainedPublicQuery(text) {
  const subjectTokens = text
    .replace(WEB_COMMAND_WORD_PATTERN, " ")
    .match(/[a-z0-9][a-z0-9.-]{2,}/gi) ?? [];
  return subjectTokens.length >= 2;
}

function resolvedIdentityAnchor(text, material, answerItem) {
  const normalizedQuestion = text.toLowerCase();
  const candidates = [String(material ?? "")];
  for (const value of [answerItem?.label]) {
    const tokens = String(value ?? "").match(/(?=[a-z0-9-]{4,}\b)(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]+/gi) ?? [];
    candidates.push(...tokens);
  }
  return candidates.find((candidate) => {
    const normalized = candidate.toLowerCase().trim();
    if (!normalized) return false;
    return new RegExp(`(?:^|[^a-z0-9])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i")
      .test(normalizedQuestion);
  }) ?? null;
}

function automaticPublicFacets(text) {
  const normalized = normalizeForPolicy(text);
  return AUTOMATIC_PUBLIC_FACETS.filter((facet) => (
    facet.pattern.test(normalized) && (!facet.exclude || !facet.exclude.test(normalized))
  ));
}

function safeAuthoritySubject(text) {
  const normalized = normalizeForPolicy(text);
  const matches = normalized.match(/\b(?:ohaus|nist|osha|fda|usda|epa|iso|astm|ansi|usp)(?:\s+\d{1,5})?\b/gi) ?? [];
  const authorities = [...new Set(matches.map((match) => match.toUpperCase()))].slice(0, 3);
  return authorities.length > 0 ? authorities.join(" ") : "OHAUS";
}

function safeAutomaticSearchQuestion(text, facets, material = "") {
  const subject = material ? `OHAUS material ${material}` : safeAuthoritySubject(text);
  const topics = facets.map((facet) => facet.query).join("; ");
  return `Find official public information for ${subject} about: ${topics}. Address every listed topic and say when official public sources do not establish one. Use primary official sources.`;
}

/**
 * Route conservatively: ambiguous prompts stay catalog-only and private live
 * commercial data never leaves the catalog lane.
 * @param {string} question
 * @param {Array<Record<string, unknown>>=} sessionContext
 */
export function googleSearchGroundingDecision(question, sessionContext = []) {
  const text = String(question ?? "").trim();
  if (!text) return { route: "catalog_only", useGoogleSearch: false, reason: "empty_question" };
  const blockedReason = sensitiveReason(text);
  if (blockedReason) {
    return { route: "private_live_unavailable", useGoogleSearch: false, reason: blockedReason };
  }
  const explicitlyRequested = EXPLICIT_WEB_SEARCH_PATTERN.test(text);
  const currentExternal = CURRENT_EXTERNAL_PATTERN.test(text) && EXTERNAL_TOPIC_PATTERN.test(text);
  const namedExternalSource = EXTERNAL_SOURCE_PATTERN.test(text)
    && (CURRENT_EXTERNAL_PATTERN.test(text) || EXTERNAL_TOPIC_PATTERN.test(text));
  if ((explicitlyRequested || currentExternal || namedExternalSource)
    && contextContainsSensitiveData(sessionContext)
    && (CONTEXT_REFERENCE_PATTERN.test(text) || !isDemonstrablySelfContainedPublicQuery(text))) {
    return { route: "private_live_unavailable", useGoogleSearch: false, reason: "private_commercial_context" };
  }
  if (!explicitlyRequested && !currentExternal && !namedExternalSource) {
    return { route: "catalog_only", useGoogleSearch: false, reason: "catalog_only" };
  }
  return {
    route: CATALOG_IDENTIFIER_PATTERN.test(text) ? "catalog_plus_web" : "public_web",
    useGoogleSearch: true,
    reason: explicitlyRequested
      ? "explicit_web_search"
      : namedExternalSource ? "external_source" : "current_external_information",
  };
}

/**
 * After one completed catalog pass, authorize an automatic public-web fallback
 * only for a genuine catalog abstention. A fixed public-topic query is built
 * here so no raw question or conversation text leaves the catalog lane.
 * @param {string} question
 * @param {Array<Record<string, unknown>>=} sessionContext
 * @param {Record<string, unknown>=} catalogAnswer
 * @param {Record<string, unknown>=} catalogHealth
 * @param {{allowLegacyCatalog?: boolean}=} options
 */
export function googleSearchFallbackDecision(
  question,
  sessionContext = [],
  catalogAnswer = {},
  catalogHealth = {},
  options = {},
) {
  const text = String(question ?? "").trim();
  if (!text) return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: "empty_question" };
  const blockedReason = sensitiveReason(text);
  if (blockedReason) {
    return { route: "private_live_unavailable", useGoogleSearch: false, automatic: true, reason: blockedReason };
  }
  if (text.length > 700 || URL_PATTERN.test(text)) {
    return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: "unbounded_or_linked_question" };
  }
  const publicFacets = automaticPublicFacets(text);
  if (publicFacets.length === 0) {
    return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: "outside_public_product_scope" };
  }
  if (contextContainsSensitiveData(sessionContext)
    && (CONTEXT_REFERENCE_PATTERN.test(text) || !isDemonstrablySelfContainedPublicQuery(text))) {
    return { route: "private_live_unavailable", useGoogleSearch: false, automatic: true, reason: "private_commercial_context" };
  }

  const catalogReady = String(catalogHealth?.retrieval_status ?? "") === "ready";
  const versionId = String(catalogHealth?.version_id ?? "").trim();
  const activeMasterCatalog = catalogReady && /^[a-zA-Z0-9_-]{1,96}$/.test(versionId);
  const allowedLocalLegacyCatalog = options?.allowLegacyCatalog === true
    && catalogReady
    && Number(catalogHealth?.materials ?? catalogHealth?.portable_products) > 0;
  const retrievalStrategy = String(catalogAnswer?.retrieval_strategy ?? "");
  const vectorizeStatus = String(catalogAnswer?.vectorize_status ?? "");
  const masterRequestVerified = activeMasterCatalog
    && MASTER_REQUEST_STRATEGIES.has(retrievalStrategy)
    && vectorizeStatus !== "fallback";
  if (!masterRequestVerified && !allowedLocalLegacyCatalog) {
    return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: "catalog_request_unverified" };
  }

  const status = String(catalogAnswer?.status ?? "");
  if (status !== "not_in_source") {
    return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: `catalog_${status || "invalid"}` };
  }

  const materials = [...new Set(Array.isArray(catalogAnswer?.materials)
    ? catalogAnswer.materials.map(String).filter(Boolean)
    : [])];
  const evidence = Array.isArray(catalogAnswer?.evidence) ? catalogAnswer.evidence : [];
  const answerItems = Array.isArray(catalogAnswer?.answer_items) ? catalogAnswer.answer_items : [];
  const unresolved = Array.isArray(catalogAnswer?.unresolved_items) ? catalogAnswer.unresolved_items : [];
  const engine = String(catalogAnswer?.answer_engine ?? "");
  const intent = String(catalogAnswer?.intent ?? "");
  const confidence = String(catalogAnswer?.confidence ?? "");
  const catalogAbstained = /(?:not\s+(?:available|present|found|provided|listed|covered|included|documented)|does\s+not\s+(?:contain|include|cover|provide|list|document)|isn['’]t\s+(?:available|present|found|provided|listed|covered|included|documented|in))[\s\S]{0,80}\bcatalog\b|\bcatalog\b[\s\S]{0,80}(?:does\s+not\s+(?:contain|include|cover|provide|list|document)|has\s+no|is\s+silent|doesn['’]t\s+(?:contain|include|cover|provide|list|document))/i
    .test(String(catalogAnswer?.answer ?? ""));

  // A deterministic exact lookup may safely anchor public Search to its one
  // server-resolved material. Unknown and ambiguous identifiers never qualify.
  const sharedProductGap = intent === "lookup"
    && catalogAbstained
    && ["high", "medium"].includes(confidence)
    && materials.length === 1
    && evidence.length === 0
    && answerItems.length === 1
    && String(answerItems[0]?.identifier ?? "") === materials[0]
    && SAFE_MATERIAL_NUMBER_PATTERN.test(materials[0])
    && unresolved.length > 0;
  const identityAnchor = sharedProductGap
    ? resolvedIdentityAnchor(text, materials[0], answerItems[0])
    : null;
  const exactProductGap = sharedProductGap && (
    engine === "catalog_fast_lane"
    || (engine === "ai"
      && CATALOG_IDENTIFIER_PATTERN.test(text)
      && identityAnchor)
  );
  if (exactProductGap) {
    return {
      route: "catalog_plus_web",
      useGoogleSearch: true,
      automatic: true,
      reason: "catalog_product_field_absent",
      searchQuestion: safeAutomaticSearchQuestion(text, publicFacets, materials[0]),
      searchFacets: publicFacets.map((facet) => facet.id),
    };
  }

  // General public questions qualify only when the catalog has no product
  // candidates or evidence. This excludes unknown IDs and partial answers.
  const publicFacetIds = publicFacets.map((facet) => facet.id);
  // Gemini can label the same company fact as lookup, unsupported, or catalog
  // scope. The fixed company-only facet classifier is the stable authority;
  // product and mixed-topic facets still depend on an explicit abstention intent.
  const companyPublicTopic = publicFacetIds.length > 0
    && publicFacetIds.every((id) => ["company_history", "company_profile"].includes(id));
  const publicTopicAbsent = (intent === "unsupported" || companyPublicTopic)
    && materials.length === 0
    && evidence.length === 0
    && answerItems.length === 0
    && unresolved.length <= 8
    && catalogAbstained
    && !CATALOG_IDENTIFIER_PATTERN.test(text)
    && isDemonstrablySelfContainedPublicQuery(text);
  if (publicTopicAbsent) {
    return {
      route: "public_web",
      useGoogleSearch: true,
      automatic: true,
      reason: "catalog_public_topic_absent",
      searchQuestion: safeAutomaticSearchQuestion(text, publicFacets),
      searchFacets: publicFacetIds,
    };
  }

  return { route: "catalog_only", useGoogleSearch: false, automatic: true, reason: "catalog_gap_not_safe_for_web" };
}
