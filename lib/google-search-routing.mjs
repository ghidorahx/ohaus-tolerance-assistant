const EXPLICIT_WEB_SEARCH_PATTERN = /\b(?:search|check|find)\b[^\n]{0,48}\b(?:google|web|online|internet)\b|\blook(?:\s+it)?\s+up\b[^\n]{0,32}\b(?:online|on\s+google|on\s+the\s+web)\b|\b(?:according\s+to|from)\b[^\n]{0,40}\b(?:google|the\s+web|an?\s+official\s+(?:site|website|page))\b/i;
const EXTERNAL_SOURCE_PATTERN = /\b(?:google|online|internet|official\s+(?:site|website|page)|manufacturer(?:'s)?\s+(?:site|website|page)|ohaus(?:'s)?\s+(?:site|website|page)|nist|osha|fda|usda|epa|iso|astm|ansi|usp|federal\s+register)\b/i;
const CURRENT_EXTERNAL_PATTERN = /\b(?:current|currently|latest|newest|recent|recently|today|this\s+(?:week|month|year)|updated?|202[4-9])\b/i;
const EXTERNAL_TOPIC_PATTERN = /\b(?:news|announcement|recall|regulation|regulatory|law|standard|guidance|requirement|certification|compliance|company|manufacturer|documentation|manual|product\s+page|press\s+release|discontinued|replacement\s+model|successor)\b/i;
const PRIVATE_COMMERCIAL_PATTERN = /\b(?:price|pricing|cost|quote|discount|inventory|in\s+stock|stock\s+(?:level|status)|availability|available\s+(?:now|today)|lead\s*time|delivery\s+(?:date|time)|ship(?:ping)?\s+(?:date|time)|customer[-\s]?specific|order\s+status|restock)\b/i;
const CATALOG_IDENTIFIER_PATTERN = /\b(?:material|item|part|model|sku)(?:\s+(?:number|no\.?|#))?\s*[:#-]?\s*[a-z0-9-]*\d[a-z0-9-]*\b|\b\d{6,8}\b|\b(?=[a-z0-9-]{4,}\b)(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9-]+\b/i;
const CONTEXT_REFERENCE_PATTERN = /\b(?:it|that|this|those|them|same|above|previous|earlier)\b/i;
const WEB_COMMAND_WORD_PATTERN = /\b(?:search|check|find|look|google|web|online|internet|up|on|the|for|please|current|currently|latest|newest|recent|recently|today)\b/gi;

function contextContainsPrivateCommercialData(sessionContext) {
  if (!Array.isArray(sessionContext)) return false;
  return sessionContext.slice(-12).some((turn) => {
    if (!turn || typeof turn !== "object") return false;
    const text = [turn.question, turn.answer, turn.contextSummary, turn.summary]
      .filter((value) => typeof value === "string")
      .map((value) => value.slice(0, 1_200))
      .join(" ");
    return PRIVATE_COMMERCIAL_PATTERN.test(text);
  });
}

function isDemonstrablySelfContainedPublicQuery(text) {
  const subjectTokens = text
    .replace(WEB_COMMAND_WORD_PATTERN, " ")
    .match(/[a-z0-9][a-z0-9.-]{2,}/gi) ?? [];
  return subjectTokens.length >= 2;
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
  if (PRIVATE_COMMERCIAL_PATTERN.test(text)) {
    return { route: "private_live_unavailable", useGoogleSearch: false, reason: "private_commercial_data" };
  }
  const explicitlyRequested = EXPLICIT_WEB_SEARCH_PATTERN.test(text);
  const currentExternal = CURRENT_EXTERNAL_PATTERN.test(text) && EXTERNAL_TOPIC_PATTERN.test(text);
  const namedExternalSource = EXTERNAL_SOURCE_PATTERN.test(text)
    && (CURRENT_EXTERNAL_PATTERN.test(text) || EXTERNAL_TOPIC_PATTERN.test(text));
  if ((explicitlyRequested || currentExternal || namedExternalSource)
    && contextContainsPrivateCommercialData(sessionContext)
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
