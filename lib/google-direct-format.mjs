// Keep citation offsets in the original answer until presentation markup is
// removed. Google offsets and JavaScript string indexes both use UTF-16 here.
export function safeGoogleSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function googleAnswerLines(answer, sources = [], citations = []) {
  const value = String(answer ?? "");
  const lines = [];
  for (const match of value.matchAll(/[^\r\n]+/g)) {
    const raw = match[0];
    if (!raw.trim()) continue;
    const prefix = raw.match(/^\s*(#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/);
    const leading = prefix?.[0].length ?? raw.length - raw.trimStart().length;
    const trailing = raw.trimEnd().length;
    const kind = prefix?.[1].startsWith("#") ? "heading"
      : prefix && /^\d/.test(prefix[1]) ? "ordered-item"
      : prefix ? "unordered-item" : "paragraph";
    const hidden = new Set();
    // Only presentation markers disappear. Model-supplied links become plain
    // text; the only clickable links are verified API citation/source URLs.
    for (const marker of raw.matchAll(/(\*\*|__|`)([^\r\n]+?)\1/g)) {
      for (let offset = 0; offset < marker[1].length; offset++) {
        hidden.add(marker.index + offset);
        hidden.add(marker.index + marker[0].length - 1 - offset);
      }
    }
    for (const link of raw.matchAll(/\[([^\]]+)\]\([^\r\n)]+\)/g)) {
      hidden.add(link.index);
      for (let index = link.index + link[1].length + 1; index < link.index + link[0].length; index++) hidden.add(index);
    }
    for (const escaped of raw.matchAll(/\\([*_`])/g)) hidden.add(escaped.index);
    let text = "";
    const offsets = Array(raw.length + 1).fill(0);
    for (let index = 0; index < raw.length; index++) {
      if (index >= leading && index < trailing && !hidden.has(index)) text += raw[index];
      offsets[index + 1] = text.length;
    }
    lines.push({ kind, text, citations: [], rawStart: match.index, rawEnd: match.index + raw.length, offsets });
  }
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || !Number.isInteger(citation.start) || !Number.isInteger(citation.end)
      || citation.start < 0 || citation.end <= citation.start || citation.end > value.length
      || !Number.isInteger(citation.source_index) || citation.source_index < 0
      || !safeGoogleSourceUrl(sources[citation.source_index]?.url)) continue;
    // Whitespace-only boundaries belong to the preceding visible line.
    const line = lines.find((candidate) => citation.end <= candidate.rawEnd)
      ?? lines.at(-1);
    if (!line) continue;
    const previous = lines[lines.indexOf(line) - 1];
    const target = citation.end <= line.rawStart && previous ? previous : line;
    const localEnd = Math.max(0, Math.min(target.offsets.length - 1, citation.end - target.rawStart));
    const offset = target.offsets[localEnd];
    if (!target.citations.some((item) => item.offset === offset && item.source_index === citation.source_index)) {
      target.citations.push({ offset, source_index: citation.source_index });
    }
  }
  return lines.map(({ kind, text, citations: items }) => ({
    kind, text, citations: items.sort((left, right) => left.offset - right.offset || left.source_index - right.source_index),
  }));
}
