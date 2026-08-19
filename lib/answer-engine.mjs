function formatNumber(value) {
  if (value == null) return "not published";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 10 });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedAliases(record) {
  return (record.aliases ?? [record.modelGroup])
    .map((alias) => String(alias).replace(/\*/g, "").trim())
    .filter(Boolean);
}

export function recordMatchesQuestion(record, question) {
  const upperQuestion = question.toUpperCase();
  return normalizedAliases(record).some((alias) => {
    const pattern = new RegExp(
      `(^|[^A-Z0-9])${escapeRegExp(alias.toUpperCase())}($|[^A-Z0-9])`,
    );
    return pattern.test(upperQuestion);
  });
}

function measureText(measure, signed = false) {
  if (!measure || measure.value == null) return "Not published";
  const prefix = signed ? "±" : "";
  const dText = measure.d != null ? ` (±${formatNumber(measure.d)}d)` : "";
  return `${prefix}${formatNumber(measure.value)} ${measure.unit ?? ""}${dText}`.trim();
}

function capacityText(record) {
  const capacity = record.capacity;
  if (!capacity || capacity.value == null) return "Not published";
  const secondary =
    capacity.secondaryValue != null
      ? ` / ${formatNumber(capacity.secondaryValue)} ${capacity.secondaryUnit ?? ""}`
      : "";
  return `${formatNumber(capacity.value)} ${capacity.unit ?? ""}${secondary}`.trim();
}

function readabilityText(record) {
  const readability = record.readability;
  if (!readability || readability.value == null) return "Not published";
  const secondary =
    readability.secondaryValue != null
      ? ` / ${formatNumber(readability.secondaryValue)} ${readability.secondaryUnit ?? ""}`
      : "";
  return `${formatNumber(readability.value)} ${readability.unit ?? ""}${secondary}`.trim();
}

function detectIntent(question) {
  const q = question.toLowerCase();
  if (/temperature|heater|setpoint|set point/.test(q)) return "temperature";
  if (/off.?center|\bocl\b|corner load/.test(q)) return "ocl";
  if (/repeatab/.test(q)) return "repeatability";
  if (/linear/.test(q)) return "linearity";
  if (/readability|resolution|smallest division|\bd value\b/.test(q)) return "readability";
  if (/capacity|maximum load|max load/.test(q)) return "capacity";
  if (/calibration.*class|weight class|which class|\bastm\b|\boiml\b/.test(q)) return "calibration";
  return "tolerance";
}

function modelAnswer(record, intent) {
  const label = record.modelGroup;
  if (intent === "repeatability") {
    return {
      text: `The ${label} repeatability specification is ${measureText(record.repeatability, true)}.`,
      factLabel: "Repeatability",
      factValue: measureText(record.repeatability, true),
    };
  }
  if (intent === "linearity") {
    return {
      text: `The ${label} linearity specification is ${measureText(record.linearity, true)}.`,
      factLabel: "Linearity",
      factValue: measureText(record.linearity, true),
    };
  }
  if (intent === "ocl") {
    return {
      text: `The ${label} off-center-load specification is ${measureText(record.ocl, true)}.`,
      factLabel: "Off-center load",
      factValue: measureText(record.ocl, true),
    };
  }
  if (intent === "readability") {
    return {
      text: `The ${label} readability is ${readabilityText(record)}.`,
      factLabel: "Readability",
      factValue: readabilityText(record),
    };
  }
  if (intent === "capacity") {
    return {
      text: `The ${label} capacity is ${capacityText(record)}.`,
      factLabel: "Capacity",
      factValue: capacityText(record),
    };
  }
  if (intent === "calibration") {
    const astm = record.calibration?.astm;
    const oiml = record.calibration?.oiml;
    const classText = astm || oiml
      ? `ASTM Class ${astm ?? "not published"} / OIML ${oiml ?? "not published"}`
      : "Not published for this record";
    return {
      text: `${label} calls for ${classText}. A tighter class is acceptable; do not substitute a looser class without reviewing the application.`,
      factLabel: "Calibration weight class",
      factValue: classText,
    };
  }
  if (!record.tolerance || record.tolerance.value == null) {
    return {
      text: `I found ${label}, but this ${record.lifecycle} record does not publish a combined tolerance. Its published repeatability is ${measureText(record.repeatability, true)} and linearity is ${measureText(record.linearity, true)}.`,
      factLabel: "Combined tolerance",
      factValue: "Not published",
    };
  }
  return {
    text: `The ${label} combined tolerance is ${measureText(record.tolerance, true)}. This is the published repeatability-plus-linearity service limit, not calibration-weight uncertainty.`,
    factLabel: "Combined tolerance",
    factValue: measureText(record.tolerance, true),
  };
}

function temperatureMatches(spec, question) {
  return String(spec.model_group)
    .split(/\s*\/\s*/)
    .some((model) => {
      const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(model.toUpperCase())}($|[^A-Z0-9])`);
      return pattern.test(question.toUpperCase());
    });
}

function guidanceAnswer(question, knowledge) {
  const q = question.toLowerCase();
  let section = null;
  if (/tolerance.*uncertainty|uncertainty.*tolerance/.test(q)) section = 2;
  else if (/\bmpe\b|maximum permissible error/.test(q)) section = 3;
  else if (/class f|nist.*class f|astm.*class f/.test(q)) section = 4;
  else if (/1\s*\/\s*3|one.?third|third rule/.test(q)) section = 7;
  else if (/astm.*oiml|oiml.*astm|class systems?/.test(q)) section = 4;
  else if (/what.*tolerance|define tolerance|weight tolerance/.test(q)) section = 1;
  if (!section) return null;

  const guide = knowledge.guidance?.find((item) => item.section === section);
  const summaries = {
    1: "Tolerance is the maximum amount a calibration weight may differ from nominal while still meeting its class. Tighter classes allow less error and generally cost more.",
    2: "Tolerance is the allowed manufacturing limit for a weight class. Uncertainty is the measured confidence range for one specific calibrated weight, reported on its certificate. Use tolerance to select a weight; use certificate uncertainty when working from that weight's calibrated value.",
    3: "MPE means maximum permissible error. For an OIML calibration weight, MPE is its tolerance. For a balance, MPE is a separate load-dependent limit defined for the weighing instrument, so the scope must be stated.",
    4: "ASTM E617 and OIML R 111 are separate weight-class systems. Their classes can be roughly cross-mapped but are not exact numerical equivalents. “Class F” in many OHAUS industrial manuals refers to NIST Handbook 44 Class F, not an ASTM E617 class.",
    7: "The one-third rule says a calibration weight's tolerance should be no more than one-third of the balance readability (d). It is a practical guideline; at very high precision, follow the manufacturer's stated class recommendation and the service procedure.",
  };
  return {
    kind: "guidance",
    text: summaries[section],
    source: guide
      ? { manual: "Master Reference guidance", page: guide.source_pdf_page }
      : undefined,
  };
}

export function answerQuestion(question, knowledge) {
  const trimmed = String(question ?? "").trim();
  if (!trimmed) return { kind: "not-found", text: "Enter a service question to begin." };

  const intent = detectIntent(trimmed);
  if (intent === "temperature") {
    const temperature = knowledge.temperatureSpecs?.filter((spec) =>
      temperatureMatches(spec, trimmed),
    ) ?? [];
    if (temperature.length === 1) {
      const spec = temperature[0];
      return {
        kind: "temperature",
        text: `${spec.model_group} has a published temperature tolerance of ±${formatNumber(spec.temperature_tolerance_c)} °C. Its display range is ${formatNumber(spec.display_range_min_c)}–${formatNumber(spec.display_range_max_c)} °C, with calibration setpoints at ${String(spec.cal_setpoints_c).replace(";", " and")} °C.`,
        temperature: spec,
        source: { manual: "Master Reference temperature table", page: spec.source_pdf_page },
      };
    }
  }

  const allRecords = [...knowledge.current, ...knowledge.legacy];
  let matches = allRecords.filter((record) => recordMatchesQuestion(record, trimmed));
  const q = trimmed.toLowerCase();
  if (matches.length > 1 && /\b(current|new|latest)\b/.test(q)) {
    matches = matches.filter((record) => record.lifecycle === "current");
  } else if (matches.length > 1 && /\b(legacy|old|older|discontinued)\b/.test(q)) {
    matches = matches.filter((record) => record.lifecycle === "legacy");
  }

  if (matches.length === 1) {
    const record = matches[0];
    const response = modelAnswer(record, intent);
    return { kind: "model", ...response, record, source: record.source };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      text: `I found ${matches.length} records for that model. Choose the applicable version so I do not mix current and legacy specifications.`,
      options: matches.map((record) => ({
        id: record.id,
        label: `${record.lifecycle === "current" ? "Current" : "Legacy"} · ${record.series}`,
        question: `${trimmed} (${record.lifecycle})`,
        source: record.source,
      })),
    };
  }

  const looksLikeUnknownModel = /\b(?=[A-Z0-9-]{4,}\b)(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]+\b/i.test(trimmed);
  if (looksLikeUnknownModel) {
    return {
      kind: "not-found",
      text: "I couldn't find that exact model in the current or legacy reference. Check the full model number and try again; partial model matches are intentionally not used.",
    };
  }

  const guide = guidanceAnswer(trimmed, knowledge);
  if (guide) return guide;

  return {
    kind: "not-found",
    text: "I couldn't identify an exact model or supported reference topic. Include the full model number, or ask about tolerance vs. uncertainty, MPE, Class F, or the one-third rule.",
  };
}

export const answerFormatting = { formatNumber, measureText, capacityText, readabilityText };
