import { getRecords } from "./sales-catalog.mjs";

const LIVE_DATA_TOPICS = Object.freeze([
  { id: "price", label: "Live pricing", pattern: /\b(?:price|pricing|cost|msrp|quote)\b/i },
  { id: "inventory", label: "Live inventory", pattern: /\b(?:inventory|in[ -]?stock|stock level|stock status)\b/i },
  { id: "restock", label: "Future restock timing", pattern: /\b(?:restock|back in (?:stock|inventory)|available again)\b/i },
  { id: "lead_time", label: "Lead time", pattern: /\b(?:lead time|ship date|shipping time|delivery date|delivery time)\b/i },
  { id: "order_status", label: "Current order status", pattern: /\b(?:order status|tracking status|has (?:the )?.*\border\b.*\bshipped|where is (?:the |my |our )?order)\b/i },
  { id: "discount", label: "Customer-specific discounts", pattern: /\b(?:customer|dealer|volume|contract)?[ -]?discounts?\b/i },
  { id: "regional_availability", label: "Current regional availability", pattern: /\b(?:regional availability|available in (?:the )?(?:us|usa|canada|mexico|europe|uk|united kingdom))\b/i },
]);

const COMMON_MISSPELLINGS = new Map([
  ["accesories", "accessories"],
  ["accesory", "accessory"],
  ["batery", "battery"],
  ["battrey", "battery"],
  ["capcity", "capacity"],
  ["compatable", "compatible"],
  ["dimentions", "dimensions"],
  ["readabilty", "readability"],
  ["readibility", "readability"],
  ["resoultion", "resolution"],
  ["stablization", "stabilization"],
]);

const FIELD_CONCEPTS = Object.freeze([
  {
    id: "capacity",
    label: "Maximum capacity",
    terms: ["maximum capacity", "capacity", "maximum load"],
    patterns: [
      /\b(?:maximum|max|rated)?\s*(?:capacity|load)\b/i,
      /\bmax(?:imum)? (?:weight|weighing)\b/i,
      /\b(?:weight|weighing) limit\b/i,
      /\bhow much (?:weight )?(?:can|will) (?:it|this|that|the (?:balance|scale|product|model)|[a-z]+\s?\d+[a-z0-9-]*)\s*weigh\b/i,
      /\bhow much weight (?:can|will) (?:it|this|that|the (?:balance|scale|product|model)|[a-z]+\s?\d+[a-z0-9-]*)\s*(?:hold|handle)\b/i,
      /\b(?:heaviest|largest|most) (?:sample|load|weight)\b/i,
      /\bweigh(?:s|ing)? up to\b/i,
    ],
    fields: [
      /(?:^|\.)maximum_capacity(?:\.display|_(?:metric|imp|rotor))?$/i,
      /(?:^|\.)(?:capacity_text|set_capacity(?:_metric|_imp)?|weigh_beam_capacity)$/i,
    ],
    maximumValues: 2,
  },
  {
    id: "readability",
    label: "Readability",
    terms: ["readability", "resolution", "smallest increment"],
    patterns: [
      /\b(?:readability|resolution|display increment|scale division|smallest (?:division|increment|step)|d value)\b/i,
      /\b(?:smallest|tiniest|least) (?:amount|change|difference|increment|weight)\b[^?]{0,36}\b(?:detect|display|measure|read|show)\b/i,
      /\bhow (?:fine|precise) (?:is|are|can)\b/i,
      /\bdecimal places?\b/i,
    ],
    fields: [
      /(?:^|\.)readability(?:\.display|_(?:metric|imp|moisture_content))?$/i,
      /(?:^|\.)(?:measurement_resolution|resolution|resolution_certified)$/i,
    ],
    maximumValues: 2,
  },
  {
    id: "included_accessories",
    label: "Included accessories",
    terms: ["accessories included", "included in the box", "package contents"],
    patterns: [
      /\b(?:what|which) (?:is|are|comes?|ships?) (?:included|in the box|with (?:it|this|that))\b/i,
      /\b(?:what|which) (?:accessories|items|parts) (?:are|come|comes|ship|ships) (?:included|in the box|with (?:it|this|that|the product))\b/i,
      /\b(?:what|which) (?:accessories|items|parts) (?:come|comes|ship|ships) with\b/i,
      /\baccessories (?:are )?included\b/i,
      /\b(?:accessories included|included accessories|package contents|box contents|comes with|ships with)\b/i,
    ],
    fields: [/(?:^|\.)(?:accessories_included|included_accessories|package_contents|box_contents)$/i],
    maximumValues: 2,
  },
  {
    id: "stabilization_time",
    label: "Stabilization time",
    terms: ["stabilization time", "settling time"],
    patterns: [
      /\b(?:stabili[sz]ation|settling|settle) time\b/i,
      /\bhow (?:fast|quickly|long) (?:does|until) (?:it|the reading|the result) (?:stabili[sz]e|settle|lock)\b/i,
      /\btime (?:to|until) (?:a )?(?:stable|final) (?:reading|result)\b/i,
    ],
    fields: [/(?:^|\.)stabili[sz]ation_time(?:\.display)?$/i],
    maximumValues: 1,
  },
  {
    id: "repeatability",
    label: "Repeatability",
    terms: ["repeatability", "repeat measurement precision"],
    patterns: [
      /\brepeatability\b/i,
      /\b(?:repeated|repeat) (?:measurement|reading|result)s?\b/i,
    ],
    fields: [/(?:^|\.)repeatability(?:\.display|_(?:metric|imp))?$/i],
    maximumValues: 2,
  },
  {
    id: "linearity",
    label: "Linearity",
    terms: ["linearity", "linearity error"],
    patterns: [/\b(?:linearity|linearity error|nonlinearity)\b/i],
    fields: [/(?:^|\.)linearity(?:\.display|_(?:metric|imp))?$/i],
    maximumValues: 2,
  },
  {
    id: "power",
    label: "Power",
    terms: ["power", "power supply", "operation"],
    patterns: [
      /\b(?:power|power supply|power source|voltage|ac adapter|mains|plugged in|outlet)\b/i,
      /\b(?:run|operate|work)s? (?:unplugged|without (?:being )?plugged in|off[ -]?grid|on batter(?:y|ies))\b/i,
      /\b(?:run|operate|work|works)\b[^?]{0,36}\b(?:on|with|using) batter(?:y|ies)\b/i,
      /\b(?:need|needs|require|requires) (?:a |an )?(?:plug|outlet|ac adapter)\b/i,
      /\bwhat powers?\b/i,
    ],
    fields: [
      /(?:^|\.)power$/i,
      /(?:^|\.)(?:operation|power_supply|power_consumption|voltage)$/i,
    ],
    maximumValues: 1,
  },
  {
    id: "battery_life",
    label: "Battery life",
    terms: ["battery life", "battery runtime"],
    patterns: [
      /\b(?:battery life|battery runtime|runtime on batter(?:y|ies)|hours on batter(?:y|ies))\b/i,
      /\bhow long (?:can|does|will) (?:it|this|that|the (?:balance|scale|product)) (?:run|operate|last)\b/i,
      /\bhow long (?:can|does|will) [a-z][a-z0-9._/-]* (?:run|operate|last)\b[^?]{0,24}\bon batter(?:y|ies)\b/i,
      /\b(?:run|operate|work)s? (?:unplugged|off[ -]?grid)\b/i,
    ],
    fields: [/(?:^|\.)battery_life$/i],
    maximumValues: 1,
  },
  {
    id: "legal_for_trade",
    label: "Legal for trade",
    terms: ["legal for trade", "trade approved", "NTEP approval"],
    patterns: [
      /\b(?:legal for trade|trade approved|ntep(?: approved| approval)?|weights and measures approved)\b/i,
      /\b(?:sell|selling|charge|charging) by weight\b/i,
      /\bcommercial transactions?\b/i,
    ],
    fields: [
      /(?:^|\.)legal_for_trade$/i,
      /(?:^|\.)(?:ntep_approval|measurement_canada_approval)$/i,
    ],
    maximumValues: 1,
  },
  {
    id: "ip_rating",
    label: "Ingress protection",
    terms: ["IP rating", "water protection", "washdown"],
    patterns: [
      /\b(?:ip rating|ingress protection|washdown|waterproof|water resistant|dustproof|dust resistant)\b/i,
      /\b(?:wet|splash|dusty) (?:area|environment|room)\b/i,
      /\bgets? (?:wet|splashed)\b/i,
      /\b(?:survive|handle|tolerate)s? (?:water|dust|splashes?)\b/i,
    ],
    fields: [/(?:^|\.)(?:ip_rating|ingress_protection|protection_rating)$/i],
    maximumValues: 1,
  },
  {
    id: "communications",
    label: "Communication",
    terms: ["communication", "interface", "USB", "RS232", "Ethernet"],
    patterns: [
      /\b(?:communication|interface|usb|rs[ -]?232|ethernet|bluetooth|wi[ -]?fi)\b/i,
      /\bconnect\b[^?]{0,48}\b(?:computer|pc|printer|network|ethernet|usb|rs[ -]?232|bluetooth|wi[ -]?fi)\b/i,
      /\b(?:send|export|transfer)\b[^?]{0,24}\b(?:data|reading|result|weight)\b/i,
      /\b(?:computer|pc|printer) connection\b/i,
    ],
    fields: [
      /(?:^|\.)communication(?:__\d+|_description|_options)?$/i,
      /(?:^|\.)(?:interface|interfaces|data_interface|usb|rs232|ethernet)$/i,
    ],
    maximumValues: 3,
  },
  {
    id: "dimensions",
    label: "Dimensions",
    terms: ["dimensions", "height", "width", "length", "footprint"],
    patterns: [
      /\b(?:dimensions?|footprint|overall size)\b/i,
      /\bhow (?:big|large|small|wide|tall|long) is (?:it|this|that|the (?:balance|scale|product)|[a-z]+\s?\d+[a-z0-9-]*)$/i,
      /\b(?:height|width|length|depth)\b/i,
    ],
    fields: [
      /(?:^|\.)dimensions?(?:\.display|_(?:height|width|length|depth)_(?:metric|imp))?$/i,
      /(?:^|\.)(?:height|width|length|depth)_(?:metric|imp)$/i,
    ],
    maximumValues: 4,
  },
  {
    id: "pan_size",
    label: "Pan or platform size",
    terms: ["pan size", "platform size", "weighing surface"],
    patterns: [
      /\b(?:pan|platform|weighing surface|weighing area) (?:dimensions?|size|width|length|diameter)\b/i,
      /\bdimensions? (?:of|for) (?:the )?(?:[a-z0-9._/-]+ ){0,2}(?:pan|platform|weighing surface)\b/i,
      /\bhow (?:big|large|wide) is (?:the )?(?:pan|platform|weighing surface)\b/i,
    ],
    fields: [
      /(?:^|\.)(?:pan|platform)_size(?:\.display|_(?:height|width|length|diameter)_(?:metric|imp))?$/i,
      /(?:^|\.)(?:pan|platform)_(?:diameter|width|length)_(?:metric|imp)$/i,
    ],
    maximumValues: 4,
  },
  {
    id: "net_weight",
    label: "Product weight",
    terms: ["net weight", "product weight"],
    patterns: [
      /\b(?:net weight|product weight|unit weight)\b/i,
      /\bhow (?:heavy is|much does) (?:it|this|that|the (?:balance|scale|product)|[a-z]+\s?\d+[a-z0-9-]*) (?:weigh|weight)?\b/i,
    ],
    fields: [
      /(?:^|\.)net_weight(?:_(?:metric|imp))?$/i,
      /(?:^|\.)weight_(?:metric|imp)$/i,
    ],
    maximumValues: 1,
  },
  {
    id: "shipping_weight",
    label: "Shipping weight",
    terms: ["shipping weight", "gross weight"],
    patterns: [/\b(?:shipping|packaged) weight\b/i],
    fields: [
      /(?:^|\.)(?:gross_weight_shipping|shipping_gross_weight|shipping_weight)(?:_(?:metric|imp))?$/i,
      /(?:^|\.)net_weight_shipping(?:_(?:metric|imp))?$/i,
      /(?:^|\.)gross_weight(?:_(?:metric|imp))?$/i,
    ],
    maximumValues: 1,
  },
  {
    id: "gross_weight",
    label: "Gross weight",
    terms: ["gross weight"],
    patterns: [/\bgross weight\b/i],
    fields: [/(?:^|\.)gross_weight(?:_(?:metric|imp))?$/i],
    maximumValues: 1,
  },
  {
    id: "units",
    label: "Units of measurement",
    terms: ["units of measurement", "weighing units"],
    patterns: [
      /\b(?:units? of measurement|weighing units?|measurement units?)\b/i,
      /\b(?:grams?|kilograms?|ounces?|pounds?|carats?)\b[^?]{0,24}\b(?:display|measure|support|unit)\b/i,
      /\bwhat units?\b/i,
    ],
    fields: [/(?:^|\.)(?:units_of_measurement|weighing_units|measurement_units)$/i],
    maximumValues: 1,
  },
  {
    id: "display",
    label: "Display",
    terms: ["display", "screen", "backlight"],
    patterns: [/\b(?:display|screen|lcd|touchscreen|backlight|backlit)\b/i],
    fields: [/(?:^|\.)(?:display|display__\d+|display_type|display_description|display_size)$/i],
    maximumValues: 2,
  },
  {
    id: "applications",
    label: "Applications",
    terms: ["application", "weighing modes", "functions"],
    patterns: [
      /\b(?:applications?|weighing modes?|functions?|what can (?:it|this|that) do)\b/i,
      /\b(?:parts counting|check ?weighing|percent weighing|density determination|animal weighing|dynamic weighing)\b/i,
    ],
    fields: [/(?:^|\.)(?:application|applications|weighing_modes|product_will_be_used)$/i],
    maximumValues: 2,
  },
  {
    id: "construction",
    label: "Construction",
    terms: ["construction", "materials", "housing", "pan construction"],
    patterns: [
      /\b(?:construction|housing|pan construction|build material|made (?:of|from))\b/i,
      /\b(?:stainless steel|abs plastic)\b/i,
    ],
    fields: [/(?:^|\.)(?:construction|pan_construction|housing|housing_material)$/i],
    maximumValues: 2,
  },
  {
    id: "environment",
    label: "Operating environment",
    terms: ["working environment", "operating temperature", "humidity"],
    patterns: [
      /\b(?:working|operating) environment\b/i,
      /\b(?:operating temperature|temperature range|humidity range|environmental conditions)\b/i,
    ],
    fields: [
      /(?:^|\.)(?:working_environment|operating_range_temp|temperature_range|humidity_range)(?:_(?:metric|imp))?$/i,
    ],
    maximumValues: 2,
  },
  {
    id: "test_weight",
    label: "Test or calibration weight",
    terms: ["test weight", "calibration weight", "weight class"],
    patterns: [
      /\b(?:test weight|calibration weight|calibration mass|weight class|astm class|oiml class)\b/i,
    ],
    fields: [/(?:^|\.)(?:test_weight|calibration_weight|calibration_mass|weight_class)$/i],
    maximumValues: 2,
  },
  {
    id: "measurement_range",
    label: "Measurement range",
    terms: ["measurement range", "measuring range"],
    patterns: [
      /\b(?:measurement|measuring) range\b/i,
      /\bwhat range (?:can|does|will)\b/i,
    ],
    fields: [/(?:^|\.)(?:measurement|measuring)_range(?:\.display|_(?:metric|imp))?$/i],
    maximumValues: 2,
  },
  {
    id: "ph_range",
    label: "pH measuring range",
    terms: ["pH measuring range", "pH range"],
    patterns: [/\bph (?:measurement |measuring )?range\b/i, /\bacross what ph range\b/i],
    fields: [/(?:^|\.)ph_(?:measurement_|measuring_)?range(?:\.display)?$/i],
    maximumValues: 1,
  },
  {
    id: "conductivity_range",
    label: "Conductivity measuring range",
    terms: ["conductivity measuring range", "conductivity range"],
    patterns: [/\bconductivity (?:measurement |measuring )?range\b/i],
    fields: [/(?:^|\.)conductivity_(?:measurement_|measuring_)?range(?:\.display)?$/i],
    maximumValues: 1,
  },
  {
    id: "accuracy",
    label: "Accuracy",
    terms: ["accuracy", "measurement accuracy"],
    patterns: [/\b(?:accuracy|measurement error|error limit)\b/i],
    fields: [/(?:^|[._])accuracy(?:[._]|$)/i, /(?:^|\.)(?:measurement_error|error_limit)$/i],
    maximumValues: 2,
  },
  {
    id: "calibration_certificate",
    label: "Calibration certificate",
    terms: ["calibration certificate", "certificate type"],
    patterns: [/\b(?:calibration|calibrated) certificates?\b/i, /\bcertificate type\b/i],
    fields: [/(?:^|\.)(?:calibration_certificate|certificate_type)$/i],
    maximumValues: 1,
  },
  {
    id: "weight_tolerance",
    label: "Weight tolerance",
    terms: ["weight tolerance", "mass tolerance"],
    patterns: [/\b(?:weight|mass) tolerance\b/i],
    fields: [/(?:^|\.)(?:weight|mass)_tolerance(?:\.display|_(?:metric|imp))?$/i],
    maximumValues: 2,
  },
  {
    id: "compatible_models",
    label: "Compatible models",
    terms: ["compatible models", "model compatibility"],
    patterns: [
      /\bcompatible models?\b/i,
      /\bwhich models? (?:is|are|does|do).*\bcompatible\b/i,
      /\bwhat models? does .*\bfit\b/i,
    ],
    fields: [/(?:^|\.)compatible_models?$/i],
    maximumValues: 2,
  },
  {
    id: "rotor_compatibility",
    label: "Rotor compatibility",
    terms: ["rotor compatibility", "compatible rotors"],
    patterns: [
      /\b(?:rotor compatibility|compatible rotors?)\b/i,
      /\bwhich rotors? (?:is|are).*\bcompatible\b/i,
    ],
    fields: [/(?:^|\.)rotor_compatibility$/i],
    maximumValues: 2,
  },
  {
    id: "sample_vial_compatibility",
    label: "Sample-vial compatibility",
    terms: ["sample vial compatibility", "compatible sample vials"],
    patterns: [/\bsample[ -]?vials?\b[^?]{0,48}\bcompatib(?:le|ility)\b/i],
    fields: [/(?:^|\.)sample_vials?_compatibility$/i],
    maximumValues: 2,
  },
  {
    id: "speed",
    label: "Speed",
    terms: ["maximum speed", "speed range", "RPM"],
    patterns: [/\b(?:maximum speed|speed range|rotation speed|stirring speed|rpm)\b/i],
    fields: [/(?:^|\.)(?:maximum_speed|speed_range|rotating_speed|stirring_speed|rocking_speed)$/i],
    maximumValues: 2,
  },
]);

function normalizeText(value) {
  return String(value ?? "")
    .replaceAll("™", " ")
    .replaceAll("®", " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => COMMON_MISSPELLINGS.get(token) ?? token)
    .join(" ");
}

function testPatterns(patterns, value) {
  return patterns.some((pattern) => pattern.test(value));
}

function catalogIdentifierCandidates(value) {
  const source = String(value ?? "");
  const candidates = [];
  const explicitPattern = /\b(?:alternative\s+model(?:\s+number)?|model\s+(?:number|no)|part\s+number|sku|material\s+number|item\s+number)\s*(?:is|#|:)?\s*([a-z0-9][a-z0-9._/-]{1,})/gi;
  for (const match of source.matchAll(explicitPattern)) {
    const candidate = match[1].replace(/[?.!,;:]+$/g, "");
    if (/\d/.test(candidate)) candidates.push(candidate);
  }
  const tokens = [...source.matchAll(/[A-Za-z0-9][A-Za-z0-9._/-]*/g)];
  for (const [index, match] of tokens.entries()) {
    const raw = match[0];
    const token = raw.replace(/^[._/-]+|[._/-]+$/g, "");
    if (/^\d{6,12}$/.test(token)) {
      const next = String(tokens[index + 1]?.[0] ?? "").replace(/[?.!,;:]+$/g, "").toLowerCase();
      if (!/^(?:g|grams?|kg|kilograms?|mg|milligrams?|lb|lbs|pounds?|oz|ounces?|rpm|ml|milliliters?|l|liters?|mm|millimeters?|cm|centimeters?|m|meters?|in|inches?|ft|feet|v|volts?|w|watts?|hz|c|celsius|f|fahrenheit|rh)$/.test(next)) {
        candidates.push(token);
      }
      continue;
    }
    if (!/^[a-z]/i.test(token) || !/\d/.test(token) || token.length < 3) continue;
    if (/^(?:rs232|ip\d+|cl\d+|\d+(?:kg|g|mg|lb|oz|rpm))$/i.test(token)) continue;
    candidates.push(token);
  }
  return [...new Set(candidates.map((candidate) => candidate.toUpperCase()))];
}

function hasAnaphoricCatalogReference(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.split(" ").length > 14) return false;
  return /\b(?:it|its|them|their)\b/i.test(normalized)
    || /\b(?:this|that|these|those) (?:model|product|item|balance|scale|unit|one|ones)\b/i.test(normalized)
    || /^(?:and )?(?:what|how) about\b/i.test(normalized)
    || /^(?:is|does|do|can|will) (?:this|that)\b/i.test(normalized)
    || /\b(?:for|with|fit|fits) (?:this|that)(?: one)?$/i.test(normalized);
}

function relationshipTypes(question) {
  const types = [];
  const replacementParts = /replacement\s*parts?/i.test(question);
  if (/spare\s*parts?/i.test(question) || replacementParts) types.push("spare_parts");
  if (/cross[ -]?sell/i.test(question)) types.push("cross_selling");
  if (/upsell/i.test(question)) types.push("upsellings");
  if (/replacement/i.test(question) && !replacementParts) types.push("replacements");
  if (/service/i.test(question)) types.push("services");
  if (/accessor/i.test(question)) types.push("accessories");
  else if (types.length === 0 && /compatible|\bfit(?:s)?\b|works? with/i.test(question)) types.push("accessories");
  return [...new Set(types)];
}

function relationshipType(question) {
  return relationshipTypes(question)[0] ?? "all";
}

function documentTypes(question) {
  const types = [];
  if (/\bmanuals?\b/i.test(question)) types.push("manual");
  if (/\b(?:data sheets?|datasheets?)\b/i.test(question)) types.push("data_sheet");
  if (/\buser guides?\b/i.test(question)) types.push("user_guide");
  if (/\b(?:certificates?|brochures?)\b/i.test(question)) types.push("unsupported");
  return [...new Set(types)];
}

export function interpretCatalogQuestion(question) {
  const original = String(question ?? "").trim();
  const normalized = normalizeText(original);
  let concepts = FIELD_CONCEPTS.filter((concept) => testPatterns(concept.patterns, normalized));
  if (concepts.some((concept) => ["ph_range", "conductivity_range"].includes(concept.id))) {
    concepts = concepts.filter((concept) => concept.id !== "measurement_range");
  }
  if (concepts.some((concept) => concept.id === "pan_size")) {
    concepts = concepts.filter((concept) => concept.id !== "dimensions");
  }
  if (/\b(?:screen|display) resolution\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => !["readability", "display"].includes(concept.id));
  } else if (/\b(?:display increment|smallest displayed increment)\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => concept.id !== "display");
  }
  if (/\b(?:battery|data|memory|storage) capacity\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => concept.id !== "capacity");
  }
  if (/\bpower (?:button|switch)\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => concept.id !== "power");
  }
  if (/\b(?:display|screen) (?:cover|film|protector)\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => concept.id !== "display");
  }
  if (/\b\d+(?:\.\d+)?\s*(?:v|volts?)\b/i.test(normalized)) {
    concepts = concepts.filter((concept) => concept.id !== "power");
  }
  const liveDataTopics = LIVE_DATA_TOPICS.filter((topic) => topic.pattern.test(normalized));
  const identifierCandidates = catalogIdentifierCandidates(original);
  const hasIdentifier = identifierCandidates.length > 0;
  const asksIncludedAccessories = concepts.some((concept) => concept.id === "included_accessories");
  const spatialFit = /\bfit(?:s)?\b[^?]{0,36}\b(?:bench|cabinet|counter|desk|hood|shelf|space|table|workstation)\b/i.test(normalized)
    || /\bfit(?:s)? (?:in|inside|into|on|onto|under|within)\b/i.test(normalized);
  const explicitRelationshipRequest = /\b(?:accessor(?:y|ies)|spare parts?|replacement parts?|cross[ -]?sell(?:ing)?|upsell(?:ing)?s?|related items?|relationships?)\b/i.test(normalized)
    || /\breplacement for\b/i.test(normalized)
    || /\bservices? (?:codes?|for|linked)\b/i.test(normalized);
  const catalogCompatibilityRequest = /\b(?:which|what) (?:catalog )?(?:accessories|models|products|items|parts|balances|scales|instruments|rotors|sample vials)\b[^?]{0,80}\b(?:compatible|fit|fits|works? with)\b/i.test(normalized)
    || /\bwhat does [a-z0-9][a-z0-9._/-]{2,} fit\b/i.test(normalized)
    || (identifierCandidates.length >= 2 && /\b(?:compatible|compatibility|fit|fits|works? with)\b/i.test(normalized));
  const asksRelationship = !asksIncludedAccessories && !spatialFit && (explicitRelationshipRequest || catalogCompatibilityRequest);
  const requestedRelationshipTypes = asksRelationship ? relationshipTypes(normalized) : [];
  const asksDocuments = /\b(?:documents?|manuals?|data sheets?|datasheets?|user guides?|brochures?)\b/i.test(normalized)
    || (/\bcertificates?\b/i.test(normalized) && /\b(?:copy|document|download|find|link|pdf|show|url)\b/i.test(normalized));
  const requestedDocumentTypes = asksDocuments ? documentTypes(normalized) : [];
  const asksCatalogListing = (
    /\b(?:categories|parent families|families)\b/i.test(normalized)
      && /\b(?:available|catalog|have|list|offer|show|what|which)\b/i.test(normalized)
  ) || /\b(?:show|list)\b[^?]{0,80}\b(?:all|every)\b[^?]{0,80}\b(?:models?|products?|items?|balances?|scales?)\b/i.test(normalized);
  const asksIdentity = /\b(?:identify|which product|catalog item|material number|part number|item number|tell me about)\b/i.test(normalized)
    || (hasIdentifier && /^what(?:\s+is|'s)\s+(?:(?:the\s+)?(?:model|part|item|material|sku)(?:\s+(?:number|no))?\s+)?[a-z0-9][a-z0-9._/-]{2,}[?.!]?$/i.test(original));
  const exhaustive = /\b(?:everything|every detail|all details|all information|all specifications|all specs|complete record|complete specifications|full specifications|full specs)\b/i.test(normalized);
  const requiresSynthesis = /\b(?:why|recommend|recommendation|best|better|should i|should we|suitable|ideal|pros and cons|explain|fit (?:my|our) needs?|right for (?:me|us|my|our))\b/i.test(normalized);
  const riskyNegation = /\b(?:but not|do not include|don't include|except|excluding|other than)\b/i.test(normalized);
  const conjunctionCount = (normalized.match(/\b(?:and|plus|as well as)\b/gi) ?? []).length;
  const likelyUnknownConjoinedClause = conjunctionCount > 0
    && concepts.length === 1
    && liveDataTopics.length === 0
    && !asksRelationship
    && !asksDocuments
    && !asksCatalogListing;
  const likelyUnknownSeparatedClause = concepts.length === 1
    && (/[;,]/.test(original) || /[a-z]\s*\/\s*[a-z]/i.test(original));
  const likelyUnknownJoinedClause = concepts.length === 1
    && liveDataTopics.length === 0
    && !asksRelationship
    && !asksDocuments
    && !asksCatalogListing
    && (/&/.test(original) || /\balso\b/i.test(normalized) || (!asksIncludedAccessories && /\bwith\b/i.test(normalized)));
  const unsupportedStaticTopic = /\b(?:warrant(?:y|ies)|warranty period)\b/i.test(normalized);
  const usesContextReference = !hasIdentifier && hasAnaphoricCatalogReference(normalized);
  const bareIdentifierLookup = hasIdentifier && /^(?:(?:alternative\s+model|model|part|item|material|sku)(?:\s+(?:number|no))?\s+)?[a-z0-9][a-z0-9._/-]{2,}[?.!]?$/i.test(original);
  const identityOnly = (asksIdentity || bareIdentifierLookup)
    && concepts.length === 0
    && liveDataTopics.length === 0
    && !asksRelationship
    && !asksDocuments
    && !asksCatalogListing;
  const relationshipOnlyConcepts = concepts.every((concept) => [
    "compatible_models",
    "rotor_compatibility",
    "sample_vial_compatibility",
  ].includes(concept.id));
  const requiresCompositeAnswer = (
    liveDataTopics.length > 0 && (concepts.length > 0 || asksRelationship || asksDocuments || asksCatalogListing)
  ) || (
    asksRelationship && concepts.length > 0 && !relationshipOnlyConcepts
  ) || (
    asksDocuments && (concepts.length > 0 || asksRelationship || asksCatalogListing)
  ) || (
    asksCatalogListing && (concepts.length > 0 || asksRelationship || asksDocuments)
  ) || requestedRelationshipTypes.length > 1
    || riskyNegation
    || likelyUnknownConjoinedClause
    || likelyUnknownSeparatedClause
    || likelyUnknownJoinedClause
    || unsupportedStaticTopic;
  const exactLookupCandidate = hasIdentifier || usesContextReference;
  const fastLaneCandidate = !exhaustive && !requiresSynthesis && !requiresCompositeAnswer && (
    liveDataTopics.length > 0
    || asksCatalogListing
    || (exactLookupCandidate && (concepts.length > 0 || asksRelationship || asksDocuments || identityOnly))
  );
  const expansionTerms = [
    ...concepts.flatMap((concept) => concept.terms),
    ...(asksRelationship ? [relationshipType(normalized).replaceAll("_", " "), "relationship"] : []),
    ...(asksDocuments ? ["document manual data sheet user guide"] : []),
  ];
  return {
    original_query: original,
    normalized_query: normalized,
    expanded_query: [...new Set([original, ...expansionTerms].filter(Boolean))].join(" "),
    concepts: concepts.map(({ id, label, terms }) => ({ id, label, terms })),
    live_data_topics: liveDataTopics.map(({ id, label }) => ({ id, label })),
    asks_relationship: asksRelationship,
    relationship_type: asksRelationship ? relationshipType(normalized) : null,
    relationship_types: requestedRelationshipTypes,
    asks_documents: asksDocuments,
    document_types: requestedDocumentTypes,
    asks_catalog_listing: asksCatalogListing,
    asks_identity: identityOnly,
    exhaustive,
    requires_synthesis: requiresSynthesis,
    requires_composite_answer: requiresCompositeAnswer,
    has_identifier: hasIdentifier,
    identifier_candidates: identifierCandidates,
    uses_context_reference: usesContextReference,
    fast_lane_candidate: fastLaneCandidate,
  };
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("; ");
  if (typeof value === "object" && "display" in value) return displayValue(value.display);
  if (typeof value === "object") return null;
  return String(value).replace(/\s+/g, " ").trim();
}

function isDisplayValueWrapper(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("display" in value)) return false;
  const companionKeys = Object.keys(value).filter((key) => key !== "display");
  return companionKeys.length <= 6 && companionKeys.every((key) => /^(?:value|secondary_value|unit|secondary_unit|seconds|minutes|hours|raw|d)$/i.test(key));
}

function flattenScalars(value, prefix = "", output = []) {
  if (value === null || value === undefined || value === "") return output;
  if (Array.isArray(value)) {
    const displayed = displayValue(value);
    if (displayed) output.push({ path: prefix, value: displayed });
    return output;
  }
  if (typeof value === "object") {
    if (isDisplayValueWrapper(value)) {
      const displayed = displayValue(value);
      if (displayed) output.push({ path: prefix, value: displayed });
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:source|documents|relationships|image|image_url)$/i.test(key)) continue;
      flattenScalars(child, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }
  const displayed = displayValue(value);
  if (displayed) output.push({ path: prefix, value: displayed });
  return output;
}

function sourceFile(record, fallback = "Loaded Excel catalog") {
  return record?.source?.file ?? record?.source_file ?? fallback;
}

function recordLabel(record) {
  return String(record?.model ?? record?.trade_name ?? record?.product_name ?? record?.material_number ?? "Catalog item");
}

function comparableRecord(record) {
  const nested = record?.record && typeof record.record === "object" ? record.record : record;
  return {
    ...nested,
    material_number: String(nested?.material_number ?? record?.material_number ?? ""),
    model: nested?.model ?? nested?.trade_name ?? record?.model ?? record?.trade_name ?? null,
    trade_name: nested?.trade_name ?? record?.trade_name ?? null,
    product_name: nested?.product_name ?? record?.product_name ?? null,
    parent_family: nested?.parent_family ?? nested?.fields?.parent_family_name ?? record?.parent_family ?? null,
    family: nested?.family ?? nested?.fields?.family_name ?? record?.family ?? null,
    source: nested?.source ?? record?.source ?? null,
  };
}

function preferredUnitScore(path, question) {
  const asksImperial = /\b(?:imperial|inch|inches|pounds?|lbs?|ounces?|oz)\b/i.test(question);
  const asksMetric = /\b(?:metric|millimeters?|centimeters?|kilograms?|grams?|\bmm\b|\bcm\b|\bkg\b)\b/i.test(question);
  if (asksImperial) return /(?:_imp|imperial)(?:\.|$)/i.test(path) ? 20 : 0;
  if (asksMetric) return /(?:_metric|metric)(?:\.|$)/i.test(path) ? 20 : 0;
  return /(?:_metric|metric|\.display)(?:\.|$)/i.test(path) ? 10 : /(?:_imp|imperial)(?:\.|$)/i.test(path) ? -4 : 0;
}

function prettyField(path) {
  return String(path)
    .replace(/^fields\./, "")
    .replace(/^specifications\./, "")
    .replace(/^sales_content\./, "")
    .replace(/^additional_attributes\./, "")
    .replace(/_(?:metric|imp)$/, (unit) => unit === "_metric" ? " (metric)" : " (imperial)")
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function conceptValues(record, conceptId, question) {
  const concept = FIELD_CONCEPTS.find((candidate) => candidate.id === conceptId);
  if (!concept) return [];
  const fields = flattenScalars(record);
  const ranked = [];
  for (const field of fields) {
    const patternIndex = concept.fields.findIndex((pattern) => pattern.test(field.path));
    if (patternIndex < 0) continue;
    ranked.push({
      ...field,
      score: 100 - patternIndex * 8 + preferredUnitScore(field.path, question),
    });
  }
  const selected = [];
  const seen = new Set();
  for (const field of ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))) {
    const key = `${normalizeText(field.value)}|${field.path.replace(/_(?:metric|imp)$/i, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(field);
    if (selected.length >= concept.maximumValues) break;
  }
  return selected;
}

function fastMetadata(base, { primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks = 0 }) {
  return {
    ...base,
    answer_engine: "catalog_fast_lane",
    ai_used: false,
    model: "Direct Excel lookup",
    primary_model: primaryModel,
    fallback_used: false,
    service_tier: "local",
    service_tier_requested: "fast",
    reasoning_effort: "none",
    reasoning_mode: "deterministic",
    output_token_cap: 0,
    output_cap_reduced: true,
    catalog_checks: 1,
    retrieval_strategy: retrievalStrategy,
    vectorize_status: vectorizeStatus,
    retrieval_documents_sent: sourceChunks,
  };
}

function baseAnswer(overrides = {}) {
  return {
    answer: "",
    answer_items: [],
    status: "answered",
    confidence: "high",
    intent: "lookup",
    materials: [],
    evidence: [],
    unresolved_items: [],
    follow_up_suggestions: [],
    context_summary: "",
    escalation_reason: null,
    ...overrides,
  };
}

function liveDataAnswer(interpretation, primaryModel) {
  if (interpretation.live_data_topics.length === 0) return null;
  const labels = interpretation.live_data_topics.map((topic) => topic.label);
  const subject = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return fastMetadata(baseAnswer({
    answer: `${subject} ${labels.length === 1 ? "is" : "are"} not available in the loaded Excel catalog. Check the current commercial system or ask the appropriate sales contact.`,
    status: "not_in_source",
    confidence: "high",
    intent: "unsupported",
    context_summary: `The user asked for ${labels.join(", ")}, which is not stored in the loaded catalog.`,
    escalation_reason: "A current commercial data source is required.",
  }), {
    primaryModel,
    retrievalStrategy: "catalog_scope",
    vectorizeStatus: "skipped",
  });
}

function ambiguousAnswer(resolutions, primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks) {
  const candidates = [...new Map(resolutions
    .flatMap((resolution) => resolution.candidates ?? [])
    .map((candidate) => [String(candidate.material_number), candidate])).values()];
  if (candidates.length === 0) return null;
  const items = candidates.slice(0, 24).map((candidate) => ({
    identifier: String(candidate.material_number),
    label: recordLabel(candidate),
    description: [candidate.product_name, candidate.parent_family, candidate.family].filter(Boolean).join(" · ") || "Possible catalog match",
  }));
  return fastMetadata(baseAnswer({
    answer: "That model name matches more than one catalog record. Choose the correct material number so the specifications are not mixed.",
    answer_items: items,
    status: "needs_clarification",
    confidence: "high",
    intent: "lookup",
    materials: items.map((item) => item.identifier),
    unresolved_items: resolutions.filter((resolution) => resolution.status === "ambiguous").map((resolution) => String(resolution.identifier)),
    context_summary: "The requested model alias is ambiguous; the listed material numbers are the verified candidates.",
  }), { primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks });
}

function missingIdentifierAnswer(resolutions, primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks) {
  const missing = resolutions.filter((resolution) => resolution.status === "not_found").map((resolution) => String(resolution.identifier));
  if (missing.length === 0) return null;
  return fastMetadata(baseAnswer({
    answer: "I couldn’t find that exact material or model in the loaded Excel catalog. Check the identifier and try again.",
    status: "not_in_source",
    confidence: "high",
    intent: "lookup",
    unresolved_items: missing,
    context_summary: `No exact catalog record was found for ${missing.join(", ")}.`,
  }), { primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks });
}

function lookupAnswer(records, interpretation, primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks, sourceFallback) {
  const resolvedRecords = [...new Map(records
    .map((record) => comparableRecord(record))
    .map((record) => [record.material_number, record])).values()];
  if (resolvedRecords.length === 0) return null;
  const requestedConcepts = interpretation.concepts;
  if (requestedConcepts.length === 0 && !interpretation.asks_identity) return null;
  const answerItems = [];
  const evidence = [];
  const unresolved = [];

  for (const record of resolvedRecords.slice(0, 6)) {
    const details = [];
    if (requestedConcepts.length === 0) {
      details.push([record.product_name, record.parent_family, record.family].filter(Boolean).join(" · ") || "Exact catalog record");
    } else {
      for (const requested of requestedConcepts) {
        const values = conceptValues(record, requested.id, interpretation.original_query);
        if (values.length === 0) {
          unresolved.push(`${recordLabel(record)}: ${requested.label}`);
          continue;
        }
        const rendered = values.length === 1
          ? values[0].value
          : values.map((value) => `${prettyField(value.path)}: ${value.value}`).join("; ");
        details.push(`${requested.label}: ${rendered}`);
        for (const value of values) {
          evidence.push({
            material_number: record.material_number,
            model_or_item: recordLabel(record),
            field: value.path,
            value: value.value,
            source_file: sourceFile(record, sourceFallback),
          });
        }
      }
    }
    answerItems.push({
      identifier: record.material_number,
      label: recordLabel(record),
      description: details.join(" · ") || `The requested field is not available in ${sourceFile(record, sourceFallback)}.`,
    });
  }

  const hasEvidence = requestedConcepts.length === 0 || evidence.length > 0;
  const allMissing = requestedConcepts.length > 0 && evidence.length === 0;
  const intent = resolvedRecords.length > 1 ? "comparison" : "lookup";
  return fastMetadata(baseAnswer({
    answer: allMissing
      ? "The requested specification is not available in the loaded Excel catalog."
      : resolvedRecords.length > 1
        ? "Here’s the requested catalog comparison."
        : "Here’s the exact information from the loaded Excel catalog.",
    answer_items: answerItems,
    status: allMissing ? "not_in_source" : "answered",
    confidence: unresolved.length > 0 ? "medium" : "high",
    intent,
    materials: answerItems.map((item) => item.identifier),
    evidence,
    unresolved_items: unresolved,
    follow_up_suggestions: hasEvidence && resolvedRecords.length === 1
      ? [`What other catalog details are available for ${recordLabel(resolvedRecords[0])}?`]
      : [],
    context_summary: `The exact catalog lookup covered ${answerItems.map((item) => `${item.label} ${item.identifier}`).join(", ")}.`,
  }), { primaryModel, retrievalStrategy, vectorizeStatus, sourceChunks });
}

function masterRelationshipAnswer(retrieval, interpretation, primaryModel) {
  if (!interpretation.asks_relationship) return null;
  if ((retrieval.warnings ?? []).some((warning) => /relationship lookup unavailable/i.test(String(warning)))) return null;
  const exactRecords = (retrieval.exact_matches ?? []).filter((item) => item.status === "found").map((item) => comparableRecord(item.record));
  const sourceMaterials = [...new Set(exactRecords.map((record) => record.material_number))];
  const exactMaterialSet = new Set(sourceMaterials);
  const rows = (retrieval.relationships ?? []).filter((row) => {
    const matchedMaterial = String(row.matched_material_number ?? (row.direction === "inbound" ? row.target_material_number : row.source_material_number) ?? "");
    const rowType = String(row.relationship_type ?? "").toLowerCase();
    const requestedType = String(interpretation.relationship_type ?? "all").toLowerCase();
    return exactMaterialSet.has(matchedMaterial) && (requestedType === "all" || rowType === requestedType);
  });
  if (exactRecords.length === 0 || rows.length === 0) return null;
  const items = [];
  const evidenceGroups = new Map();
  for (const row of rows) {
    const inbound = row.direction === "inbound";
    const identifier = String(row.related_material_number ?? (inbound ? row.source_material_number : row.target_material_number) ?? "");
    if (!identifier || items.some((item) => item.identifier === identifier)) continue;
    const label = String((inbound ? row.source_model ?? row.source_product_name : row.target_model ?? row.target_product_name) ?? "Catalog item");
    const type = String(row.relationship_type ?? interpretation.relationship_type ?? "related item").replaceAll("_", " ");
    const unresolved = Number(row.target_resolved) !== 1;
    items.push({
      identifier,
      label,
      description: `${type} listed in the Excel catalog${unresolved ? "; related catalog record unresolved" : ""}`,
    });
    const sourceMaterial = String(row.matched_material_number ?? (inbound ? row.target_material_number : row.source_material_number) ?? sourceMaterials[0]);
    const key = `${sourceMaterial}|${type}`;
    const group = evidenceGroups.get(key) ?? [];
    group.push(`${identifier} — ${label}`);
    evidenceGroups.set(key, group);
    if (items.length >= 24) break;
  }
  const displayTruncated = Boolean(retrieval.relationships_truncated) || rows.length > items.length;
  const sourceLabel = exactRecords.map(recordLabel).join(", ");
  const relationshipLabel = String(interpretation.relationship_type ?? "related items").replaceAll("_", " ");
  const evidence = [...evidenceGroups.entries()].map(([key, values]) => {
    const [material, type] = key.split("|");
    const record = exactRecords.find((candidate) => candidate.material_number === material) ?? exactRecords[0];
    return {
      material_number: material,
      model_or_item: recordLabel(record),
      field: `relationships.${type.replaceAll(" ", "_")}`,
      value: values.join("; "),
      source_file: sourceFile(record, retrieval.version?.source_file),
    };
  });
  return fastMetadata(baseAnswer({
    answer: items.length > 0
      ? `${rows.length}${retrieval.relationships_truncated ? "+" : ""} ${relationshipLabel} ${rows.length === 1 ? "is" : "are"} listed for ${sourceLabel}${displayTruncated ? `; showing the first ${items.length}` : ""}.`
      : `No ${relationshipLabel} are listed for ${sourceLabel} in the loaded Excel catalog.`,
    answer_items: items,
    status: "answered",
    confidence: displayTruncated ? "medium" : "high",
    intent: "relationship",
    materials: [...new Set([...sourceMaterials, ...items.map((item) => item.identifier)])].slice(0, 24),
    evidence,
    unresolved_items: displayTruncated ? ["Additional relationships are not shown; narrow the relationship type to see a smaller set."] : [],
    context_summary: `The relationship lookup used exact records for ${sourceLabel}.`,
  }), {
    primaryModel,
    retrievalStrategy: retrieval.retrieval?.strategy ?? "exact",
    vectorizeStatus: retrieval.retrieval?.semantic?.status ?? "skipped",
    sourceChunks: retrieval.chunks?.length ?? 0,
  });
}

function legacyRelationshipAnswer(grounding, interpretation, primaryModel) {
  if (!interpretation.asks_relationship) return null;
  const groups = grounding.relationship_results ?? [];
  if (groups.length === 0) return null;
  const items = [];
  const evidence = [];
  const sourceMaterials = [];
  for (const group of groups) {
    const source = comparableRecord(group.source ?? {});
    if (source.material_number) sourceMaterials.push(source.material_number);
    const relationships = (group.relationships ?? []).filter((relationship) => (
      interpretation.relationship_type === "all"
      || relationship.relationship_type === interpretation.relationship_type
    ));
    for (const relationship of relationships) {
      const identifier = String(relationship.related_material_number ?? "");
      if (!identifier || items.some((item) => item.identifier === identifier)) continue;
      const label = String(relationship.related_item?.model ?? relationship.related_item?.product_name ?? "Catalog item");
      const type = String(relationship.relationship_type ?? "related item").replaceAll("_", " ");
      const unresolved = relationship.resolution_status && relationship.resolution_status !== "resolved";
      items.push({
        identifier,
        label,
        description: `${type} listed in the Excel catalog${unresolved ? "; related catalog record unresolved" : ""}`,
      });
    }
    if (relationships.length > 0) {
      evidence.push({
        material_number: source.material_number,
        model_or_item: recordLabel(source),
        field: `relationships.${interpretation.relationship_type ?? "all"}`,
        value: relationships.map((item) => String(item.related_material_number)).join("; "),
        source_file: sourceFile(source, grounding.source_file),
      });
    }
  }
  const sourceLabels = groups.map((group) => recordLabel(group.source ?? {})).join(", ");
  const relationshipLabel = String(interpretation.relationship_type ?? "related items").replaceAll("_", " ");
  return fastMetadata(baseAnswer({
    answer: items.length > 0
      ? `${items.length} ${relationshipLabel} ${items.length === 1 ? "is" : "are"} listed for ${sourceLabels}.`
      : `No ${relationshipLabel} are listed for ${sourceLabels} in the loaded Excel catalog.`,
    answer_items: items.slice(0, 24),
    intent: "relationship",
    materials: [...new Set([...sourceMaterials, ...items.map((item) => item.identifier)])].slice(0, 24),
    evidence,
    context_summary: `The relationship lookup used exact records for ${sourceLabels}.`,
  }), {
    primaryModel,
    retrievalStrategy: "exact_relationship",
    vectorizeStatus: "skipped",
  });
}

function catalogListingAnswer(retrieval, interpretation, primaryModel) {
  if (!interpretation.asks_catalog_listing || !retrieval.catalog_listing?.requested) return null;
  const listing = retrieval.catalog_listing;
  if (!["ready", "no_results"].includes(listing.status)) return null;
  if (listing.kind === "materials_by_category") {
    const items = (listing.items ?? []).slice(0, 24).map((item) => ({
      identifier: String(item.material_number),
      label: recordLabel(item),
      description: [item.description ?? item.product_name, item.family].filter(Boolean).join(" · ") || "Catalog item",
    }));
    return fastMetadata(baseAnswer({
      answer: items.length > 0
        ? `${listing.total_count} catalog item${listing.total_count === 1 ? "" : "s"} ${listing.total_count === 1 ? "is" : "are"} listed in ${listing.category?.name ?? "that category"}${listing.truncated ? "; showing the first results" : ""}.`
        : `No catalog items are listed in ${listing.category?.name ?? "that category"}.`,
      answer_items: items,
      intent: "catalog_scope",
      materials: items.map((item) => item.identifier),
      unresolved_items: listing.truncated ? ["The category contains more items than are shown; narrow the request to see a focused list."] : [],
      context_summary: `The catalog category lookup covered ${listing.category?.name ?? "the requested category"}.`,
    }), {
      primaryModel,
      retrievalStrategy: "catalog_scope",
      vectorizeStatus: "skipped",
      sourceChunks: 0,
    });
  }
  const names = (listing.items ?? []).map((item) => `${item.name} (${item.material_count})`);
  return fastMetadata(baseAnswer({
    answer: names.length > 0
      ? `The loaded catalog contains ${listing.total_count} ${listing.kind === "parent_families" ? "parent families" : "families"}:\n\n${names.map((name) => `- ${name}`).join("\n")}`
      : "No matching catalog categories were found.",
    intent: "catalog_scope",
    context_summary: `The catalog scope lookup returned ${names.length} category names.`,
  }), {
    primaryModel,
    retrievalStrategy: "catalog_scope",
    vectorizeStatus: "skipped",
  });
}

function masterDocumentAnswer(retrieval, interpretation, primaryModel) {
  if (!interpretation.asks_documents) return null;
  if (interpretation.document_types?.includes("unsupported")) return null;
  if (retrieval.documents_status !== "ready") return null;
  const exactRecords = (retrieval.exact_matches ?? []).filter((item) => item.status === "found").map((item) => comparableRecord(item.record));
  if (exactRecords.length === 0) return null;
  const exactMaterialSet = new Set(exactRecords.map((record) => record.material_number));
  const requestedTypes = (interpretation.document_types ?? []).filter((type) => type !== "unsupported");
  const documents = (retrieval.documents ?? []).filter((document) => (
    exactMaterialSet.has(String(document.material_number ?? ""))
    && (requestedTypes.length === 0 || requestedTypes.includes(String(document.document_type ?? "")))
  ));
  const evidence = documents.slice(0, 24).map((document) => {
    const record = exactRecords.find((item) => item.material_number === String(document.material_number)) ?? exactRecords[0];
    return {
      material_number: String(document.material_number ?? record.material_number),
      model_or_item: recordLabel(record),
      field: `documents.${String(document.document_type ?? "document").replaceAll(" ", "_")}`,
      value: String(document.url),
      source_file: sourceFile(record, retrieval.version?.source_file),
    };
  });
  const items = exactRecords.map((record) => ({
    identifier: record.material_number,
    label: recordLabel(record),
    description: documents.length > 0
      ? `${documents.length}${retrieval.documents_truncated ? "+" : ""} document link${documents.length === 1 ? "" : "s"} found${retrieval.documents_truncated ? "; showing the first results" : ""}`
      : "No document links are listed",
  }));
  const links = documents.slice(0, 12).map((document) => `- ${String(document.document_type ?? "Document").replaceAll("_", " ")}: ${document.url}`).join("\n");
  return fastMetadata(baseAnswer({
    answer: documents.length > 0
      ? `Here are the document links listed in the Excel catalog${retrieval.documents_truncated ? " (showing the first results)" : ""}:\n\n${links}`
      : "No document links are listed for that exact catalog item.",
    answer_items: items,
    intent: "lookup",
    materials: items.map((item) => item.identifier),
    evidence,
    confidence: retrieval.documents_truncated ? "medium" : "high",
    unresolved_items: retrieval.documents_truncated ? ["Additional document links are not shown; narrow the requested document type."] : [],
    context_summary: `The document lookup used exact catalog records for ${items.map((item) => item.label).join(", ")}.`,
  }), {
    primaryModel,
    retrievalStrategy: retrieval.retrieval?.strategy ?? "exact",
    vectorizeStatus: "skipped",
    sourceChunks: retrieval.chunks?.length ?? 0,
  });
}

export function answerMasterCatalogFastLane({ question, interpretation = interpretCatalogQuestion(question), retrieval, primaryModel = "gpt-5.6-sol" }) {
  if (!interpretation.fast_lane_candidate) return null;
  const unsupported = liveDataAnswer(interpretation, primaryModel);
  if (unsupported) return unsupported;
  if (!retrieval?.version || !["ready", "no_results"].includes(retrieval.status)) return null;
  const strategy = retrieval.retrieval?.strategy ?? "exact";
  const vectorizeStatus = retrieval.retrieval?.semantic?.status ?? "skipped";
  const sourceChunks = retrieval.chunks?.length ?? 0;
  const resolutions = retrieval.exact_matches ?? [];
  const ambiguous = ambiguousAnswer(resolutions.filter((item) => item.status === "ambiguous"), primaryModel, strategy, vectorizeStatus, sourceChunks);
  if (ambiguous) return ambiguous;
  const hasFoundResolution = resolutions.some((item) => item.status === "found");
  if (hasFoundResolution && resolutions.some((item) => item.status === "not_found")) return null;
  const records = [...new Map(resolutions
    .filter((item) => item.status === "found" && item.record)
    .map((item) => comparableRecord(item.record))
    .map((record) => [record.material_number, record])).values()];
  if (records.length > 1 && (interpretation.asks_relationship || interpretation.asks_documents)) return null;
  const listing = catalogListingAnswer(retrieval, interpretation, primaryModel);
  if (listing) return listing;
  const scalarCompatibilityRequested = interpretation.concepts.some((concept) => [
    "compatible_models",
    "rotor_compatibility",
    "sample_vial_compatibility",
  ].includes(concept.id));
  if (scalarCompatibilityRequested) {
    const compatibility = lookupAnswer(records, interpretation, primaryModel, strategy, vectorizeStatus, sourceChunks, retrieval.version.source_file);
    if (compatibility && compatibility.status !== "not_in_source") return compatibility;
  }
  const relationship = masterRelationshipAnswer(retrieval, interpretation, primaryModel);
  if (relationship) return relationship;
  const documents = masterDocumentAnswer(retrieval, interpretation, primaryModel);
  if (documents) return documents;
  const lookup = lookupAnswer(records, interpretation, primaryModel, strategy, vectorizeStatus, sourceChunks, retrieval.version.source_file);
  if (lookup) return lookup;
  return missingIdentifierAnswer(resolutions, primaryModel, strategy, vectorizeStatus, sourceChunks);
}

export function answerLegacyCatalogFastLane({ question, interpretation = interpretCatalogQuestion(question), grounding, primaryModel = "gpt-5.6-sol" }) {
  if (!interpretation.fast_lane_candidate) return null;
  const unsupported = liveDataAnswer(interpretation, primaryModel);
  if (unsupported) return unsupported;
  if (!grounding) return null;
  const exact = grounding.exact_identifier_matches ?? [];
  const requestedIdentifiers = interpretation.identifier_candidates ?? [];
  const requestedResolutions = requestedIdentifiers.length > 0
    ? getRecords({ identifiers: requestedIdentifiers, sections: ["all"] }).results
    : [];
  const requestedAmbiguous = ambiguousAnswer(
    requestedResolutions.filter((item) => item.status === "ambiguous"),
    primaryModel,
    "exact_local",
    "skipped",
    0,
  );
  if (requestedAmbiguous) return requestedAmbiguous;
  const requestedFound = requestedResolutions.filter((item) => item.status === "found");
  const requestedMissing = requestedResolutions.filter((item) => item.status === "not_found");
  if (requestedFound.length > 0 && requestedMissing.length > 0) return null;
  if (requestedFound.length === 0 && requestedMissing.length > 0) {
    return missingIdentifierAnswer(requestedMissing, primaryModel, "exact_local", "skipped", 0);
  }
  const ambiguousResolutions = exact.filter((item) => item.status === "ambiguous").map((item) => ({
    ...item,
    candidates: item.candidates ?? [],
  }));
  const ambiguous = ambiguousAnswer(ambiguousResolutions, primaryModel, "exact", "skipped", 0);
  if (ambiguous) return ambiguous;
  const exactFoundMaterials = [...new Set(exact
    .filter((item) => item.status === "found")
    .map((item) => String(item.record?.material_number ?? ""))
    .filter(Boolean))];
  const resolvedMaterialCount = new Set([
    ...requestedFound.map((item) => String(item.record?.material_number ?? "")).filter(Boolean),
    ...exactFoundMaterials,
  ]).size;
  if (resolvedMaterialCount > 1 && (interpretation.asks_relationship || interpretation.asks_documents)) return null;
  const relationship = legacyRelationshipAnswer(grounding, interpretation, primaryModel);
  if (relationship) return relationship;
  if (interpretation.asks_documents) return null;
  const materialNumbers = [...new Set(exact.filter((item) => item.status === "found").map((item) => String(item.record?.material_number ?? "")).filter(Boolean))];
  const resolutions = requestedFound.length > 0
    ? requestedFound
    : materialNumbers.length > 0
      ? getRecords({ identifiers: materialNumbers, sections: ["all"] }).results
      : [];
  const records = resolutions.filter((item) => item.status === "found").map((item) => comparableRecord(item.record));
  const lookup = lookupAnswer(records, interpretation, primaryModel, "exact_local", "skipped", 0, grounding.source_file);
  if (lookup) return lookup;
  const missing = exact.filter((item) => item.status === "not_found").map((item) => ({ ...item, candidates: [] }));
  return missingIdentifierAnswer(missing, primaryModel, "exact_local", "skipped", 0);
}

export const catalogFastLaneConcepts = FIELD_CONCEPTS.map(({ id, label, terms }) => ({ id, label, terms }));
