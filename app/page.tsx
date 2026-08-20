"use client";

import {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

type AssistantMode = "tolerance" | "sales" | "compatibility";

type NetworkNodeKind = "root" | "family" | "category" | "series" | "model" | "part";
type RelationshipState = "compatible" | "incompatible" | "discontinued";

type NetworkNode = {
  id: string;
  label: string;
  kind: NetworkNodeKind;
  parentId?: string;
  detail: string;
  verified?: boolean;
};

type NetworkLink = {
  source: string;
  target: string;
  state: RelationshipState;
  label: string;
};

type PositionedNode = NetworkNode & {
  x: number;
  y: number;
  relationState?: RelationshipState;
};

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

const networkNodes: NetworkNode[] = [
  { id: "ohaus", label: "OHAUS", kind: "root", detail: "The center of the product and compatibility network." },
  { id: "balances-scales", label: "Balances & Scales", kind: "family", parentId: "ohaus", detail: "Laboratory, portable, industrial, retail, and moisture-analysis weighing products." },
  { id: "instruments", label: "Instruments", kind: "family", parentId: "ohaus", detail: "Water analysis, color measurement, and turbidity instruments." },
  { id: "lab-equipment", label: "Laboratory Equipment", kind: "family", parentId: "ohaus", detail: "Sample preparation, mixing, heating, stirring, and supporting laboratory equipment." },
  { id: "weights", label: "Weights", kind: "family", parentId: "ohaus", detail: "Reference, calibration, test, hooked, slotted, and education weights." },
  { id: "accessories-printers", label: "Accessories & Printers", kind: "family", parentId: "ohaus", detail: "Accessories, interfaces, replacement items, and printing solutions that connect to product families." },

  { id: "portable-balances", label: "Portable Balances", kind: "category", parentId: "balances-scales", detail: "Portable weighing families including Scout, Navigator, and Compass." },
  { id: "analytical-balances", label: "Analytical Balances", kind: "category", parentId: "balances-scales", detail: "High-resolution balance families for analytical weighing." },
  { id: "bench-scales", label: "Bench Scales", kind: "category", parentId: "balances-scales", detail: "Compact and industrial bench-scale families." },
  { id: "moisture-analyzers", label: "Moisture Analyzers", kind: "category", parentId: "balances-scales", detail: "Moisture-analysis instruments and their compatible accessories." },

  { id: "scout-spx", label: "Scout SPX", kind: "series", parentId: "portable-balances", detail: "The first series with verified compatibility rules in this pilot.", verified: true },
  { id: "scout-stx", label: "Scout STX", kind: "series", parentId: "portable-balances", detail: "Portable balance series; compatibility links will appear as verified data is added." },
  { id: "scout-skx", label: "Scout SKX", kind: "series", parentId: "portable-balances", detail: "Portable balance series; compatibility links will appear as verified data is added." },
  { id: "navigator", label: "Navigator", kind: "series", parentId: "portable-balances", detail: "Portable balance series awaiting verified compatibility links." },

  { id: "explorer", label: "Explorer", kind: "series", parentId: "analytical-balances", detail: "Analytical balance family awaiting verified model and accessory links." },
  { id: "adventurer", label: "Adventurer", kind: "series", parentId: "analytical-balances", detail: "Analytical balance family awaiting verified model and accessory links." },
  { id: "pioneer", label: "Pioneer", kind: "series", parentId: "analytical-balances", detail: "Analytical balance family awaiting verified model and accessory links." },
  { id: "pr-series", label: "PR Series", kind: "series", parentId: "analytical-balances", detail: "Analytical balance family awaiting verified model and accessory links." },

  { id: "defender", label: "Defender", kind: "series", parentId: "bench-scales", detail: "Industrial bench-scale family awaiting verified configuration and accessory links." },
  { id: "ranger", label: "Ranger", kind: "series", parentId: "bench-scales", detail: "Compact industrial scale family awaiting verified configuration and accessory links." },
  { id: "valor", label: "Valor", kind: "series", parentId: "bench-scales", detail: "Food and washdown scale family awaiting verified configuration and accessory links." },

  { id: "mb120", label: "MB120", kind: "series", parentId: "moisture-analyzers", detail: "Moisture analyzer awaiting verified accessory links." },
  { id: "mb92", label: "MB92", kind: "series", parentId: "moisture-analyzers", detail: "Moisture analyzer awaiting verified accessory links." },
  { id: "mb62", label: "MB62", kind: "series", parentId: "moisture-analyzers", detail: "Moisture analyzer awaiting verified accessory links." },
  { id: "mb32", label: "MB32", kind: "series", parentId: "moisture-analyzers", detail: "Moisture analyzer awaiting verified accessory links." },

  { id: "water-analysis", label: "Water Analysis", kind: "category", parentId: "instruments", detail: "Meters, electrodes, and multi-parameter water-analysis products." },
  { id: "colorimeters", label: "Colorimeters", kind: "category", parentId: "instruments", detail: "Portable color-measurement instruments." },
  { id: "turbidimeters", label: "Turbidimeters", kind: "category", parentId: "instruments", detail: "Portable turbidity-measurement instruments." },
  { id: "aquasearcher", label: "AQUASEARCHER", kind: "series", parentId: "water-analysis", detail: "Water-analysis family awaiting verified electrode and accessory links." },
  { id: "starter", label: "Starter", kind: "series", parentId: "water-analysis", detail: "Meter and electrode family awaiting verified compatibility links." },
  { id: "ap50", label: "AP50", kind: "series", parentId: "colorimeters", detail: "Portable colorimeter family awaiting verified accessory links." },
  { id: "ap30", label: "AP30", kind: "series", parentId: "turbidimeters", detail: "Portable turbidimeter family awaiting verified accessory links." },

  { id: "centrifuges", label: "Centrifuges", kind: "category", parentId: "lab-equipment", detail: "Centrifuges, rotors, and related labware compatibility." },
  { id: "shakers", label: "Shakers", kind: "category", parentId: "lab-equipment", detail: "Open-air, incubating, cooling, rocking, and orbital shakers." },
  { id: "hotplates-stirrers", label: "Hotplates & Stirrers", kind: "category", parentId: "lab-equipment", detail: "Heating and stirring products with probes, supports, and accessories." },
  { id: "vortex-mixers", label: "Vortex Mixers", kind: "category", parentId: "lab-equipment", detail: "Single- and multi-sample vortex mixer families." },
  { id: "frontier-5000", label: "Frontier 5000", kind: "series", parentId: "centrifuges", detail: "Centrifuge family awaiting verified rotor and accessory links." },
  { id: "endeavor-5000", label: "Endeavor 5000", kind: "series", parentId: "shakers", detail: "Shaker family awaiting verified platform and clamp links." },
  { id: "guardian", label: "Guardian", kind: "series", parentId: "hotplates-stirrers", detail: "Hotplate and stirrer family awaiting verified probe and accessory links." },
  { id: "vortex-genie", label: "Vortex-Genie", kind: "series", parentId: "vortex-mixers", detail: "Vortex mixer family awaiting verified attachment links." },

  { id: "reference-weights", label: "Reference Weights", kind: "category", parentId: "weights", detail: "Reference calibration weights and mass standards." },
  { id: "calibration-weights", label: "Calibration Weights", kind: "category", parentId: "weights", detail: "ASTM and OIML calibration-weight families." },
  { id: "test-weights", label: "Scale & Test Weights", kind: "category", parentId: "weights", detail: "Weights for scale calibration and testing." },
  { id: "astm-reference", label: "ASTM Reference", kind: "series", parentId: "reference-weights", detail: "Reference-weight family awaiting verified balance-class links." },
  { id: "astm-calibration", label: "ASTM Calibration", kind: "series", parentId: "calibration-weights", detail: "Calibration-weight family awaiting verified balance-class links." },
  { id: "oiml-calibration", label: "OIML Calibration", kind: "series", parentId: "calibration-weights", detail: "Calibration-weight family awaiting verified balance-class links." },
  { id: "astm-test", label: "ASTM Scale Weights", kind: "series", parentId: "test-weights", detail: "Scale-weight family awaiting verified equipment links." },

  { id: "adapters", label: "Power & Adapters", kind: "category", parentId: "accessories-printers", detail: "Replacement power components linked to supported product series." },
  { id: "covers-shields", label: "Covers & Shields", kind: "category", parentId: "accessories-printers", detail: "Protective covers and draft-shield compatibility." },
  { id: "interfaces", label: "Interfaces", kind: "category", parentId: "accessories-printers", detail: "Cables, kits, and communication accessories." },
  { id: "printers", label: "Printers", kind: "category", parentId: "accessories-printers", detail: "Printing products and supported equipment connections." },

  { id: "spx123", label: "SPX123", kind: "model", parentId: "scout-spx", detail: "Scout SPX model with a draft shield.", verified: true },
  { id: "spx223", label: "SPX223", kind: "model", parentId: "scout-spx", detail: "Scout SPX model with a draft shield.", verified: true },

  { id: "adapter-30330714", label: "30330714 Adapter", kind: "part", detail: "The only replacement power adapter currently offered for the Scout series.", verified: true },
  { id: "stacking-cover", label: "Stacking Cover", kind: "part", detail: "Not compatible with SPX123 or SPX223 because those models have draft shields.", verified: true },
  { id: "bluetooth-accessory", label: "Bluetooth Accessory", kind: "part", detail: "No longer available and no longer supported.", verified: true },
];

const networkLinks: NetworkLink[] = [
  { source: "scout-spx", target: "adapter-30330714", state: "compatible", label: "Compatible replacement" },
  { source: "scout-spx", target: "bluetooth-accessory", state: "discontinued", label: "No longer available or supported" },
  { source: "spx123", target: "stacking-cover", state: "incompatible", label: "Not compatible · draft shield" },
  { source: "spx223", target: "stacking-cover", state: "incompatible", label: "Not compatible · draft shield" },
];

const familyAngles: Record<string, number> = {
  "balances-scales": -90,
  instruments: -18,
  "lab-equipment": 54,
  weights: 126,
  "accessories-printers": 198,
};

function polarPosition(angle: number, radius: number) {
  const radians = angle * Math.PI / 180;
  return {
    x: 50 + Math.cos(radians) * radius * .76,
    y: 50 + Math.sin(radians) * radius,
  };
}

function CompatibilityWeb() {
  const nodeMap = useMemo(() => new Map(networkNodes.map((node) => [node.id, node])), []);
  const [path, setPath] = useState<string[]>(["ohaus"]);
  const [selectedId, setSelectedId] = useState("ohaus");
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeId = path[path.length - 1];
  const activeNode = nodeMap.get(activeId) ?? networkNodes[0];
  const selectedNode = nodeMap.get(selectedId) ?? activeNode;

  const children = useMemo(
    () => networkNodes.filter((node) => node.parentId === activeId),
    [activeId],
  );

  const visibleLinks = useMemo(
    () => networkLinks.filter((link) => path.includes(link.source)),
    [path],
  );

  const positionedNodes = useMemo(() => {
    const positioned: PositionedNode[] = [{ ...networkNodes[0], x: 50, y: 50 }];
    const families = networkNodes.filter((node) => node.parentId === "ohaus");

    families.forEach((family) => {
      const point = polarPosition(familyAngles[family.id], 20);
      positioned.push({ ...family, ...point });
    });

    const activeFamilyId = path[1];
    const baseAngle = familyAngles[activeFamilyId] ?? -90;
    path.slice(2).forEach((nodeId, index) => {
      const node = nodeMap.get(nodeId);
      if (!node) return;
      const point = polarPosition(baseAngle + index * 9, 31 + index * 9);
      positioned.push({ ...node, ...point });
    });

    const pathDepth = path.length - 1;
    const childRadius = Math.min(47, pathDepth < 2 ? 39 : 43 + (pathDepth - 2) * 4);
    const childCenterAngle = baseAngle + Math.max(0, pathDepth - 1) * 9;
    const childSpread = children.length > 1 ? Math.min(54, 15 * (children.length - 1)) : 0;

    children.forEach((child, index) => {
      if (path.includes(child.id)) return;
      const offset = children.length > 1 ? -childSpread / 2 + (childSpread / (children.length - 1)) * index : 0;
      const point = polarPosition(childCenterAngle + offset, childRadius);
      positioned.push({ ...child, ...point });
    });

    const relatedTargets = Array.from(new Set(visibleLinks.map((link) => link.target)));
    const relationCenterAngle = baseAngle + 92;
    const relationSpread = relatedTargets.length > 1 ? 30 : 0;

    relatedTargets.forEach((targetId, index) => {
      const node = nodeMap.get(targetId);
      const link = visibleLinks.find((item) => item.target === targetId);
      if (!node || positioned.some((item) => item.id === targetId)) return;
      const offset = relatedTargets.length > 1
        ? -relationSpread / 2 + (relationSpread / (relatedTargets.length - 1)) * index
        : 0;
      const point = polarPosition(relationCenterAngle + offset, 43);
      positioned.push({ ...node, ...point, relationState: link?.state });
    });

    return positioned;
  }, [children, nodeMap, path, visibleLinks]);

  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(positionedNodes.map((node) => node.id));
    const hierarchy = positionedNodes
      .filter((node) => node.parentId && visibleIds.has(node.parentId))
      .map((node) => ({ source: node.parentId as string, target: node.id, state: "hierarchy" as const }));
    const relationships = visibleLinks
      .filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target))
      .map((link) => ({ source: link.source, target: link.target, state: link.state }));
    return [...hierarchy, ...relationships];
  }, [positionedNodes, visibleLinks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    function drawNetwork() {
      if (!canvas || !stage) return;
      const rect = stage.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      const positionMap = new Map(positionedNodes.map((node) => [node.id, node]));

      visibleEdges.forEach((edge) => {
        const source = positionMap.get(edge.source);
        const target = positionMap.get(edge.target);
        if (!source || !target) return;
        const startX = source.x / 100 * rect.width;
        const startY = source.y / 100 * rect.height;
        const endX = target.x / 100 * rect.width;
        const endY = target.y / 100 * rect.height;
        const relation = edge.state !== "hierarchy";
        const colors = {
          hierarchy: "rgba(136, 38, 57, .28)",
          compatible: "rgba(34, 133, 91, .84)",
          incompatible: "rgba(190, 69, 42, .84)",
          discontinued: "rgba(108, 119, 130, .75)",
        };
        context.beginPath();
        context.moveTo(startX, startY);
        context.quadraticCurveTo((startX + endX) / 2, (startY + endY) / 2 - (relation ? 14 : 4), endX, endY);
        context.strokeStyle = colors[edge.state];
        context.lineWidth = relation ? 2.4 : 1.25;
        context.setLineDash(edge.state === "incompatible" ? [7, 5] : edge.state === "discontinued" ? [2, 6] : []);
        context.stroke();
      });
      context.setLineDash([]);
    }

    const resizeObserver = new ResizeObserver(drawNetwork);
    resizeObserver.observe(stage);
    drawNetwork();
    return () => resizeObserver.disconnect();
  }, [positionedNodes, visibleEdges]);

  function pathToNode(nodeId: string) {
    const nextPath: string[] = [];
    let current = nodeMap.get(nodeId);
    while (current) {
      nextPath.unshift(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    return nextPath;
  }

  function selectNode(node: PositionedNode) {
    setSelectedId(node.id);
    if (node.kind !== "part") setPath(pathToNode(node.id));
  }

  function goBack() {
    if (path.length === 1) return;
    const nextPath = path.slice(0, -1);
    setPath(nextPath);
    setSelectedId(nextPath[nextPath.length - 1]);
  }

  function resetWeb() {
    setPath(["ohaus"]);
    setSelectedId("ohaus");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const xRatio = (event.clientX - rect.left) / rect.width - .5;
    const yRatio = (event.clientY - rect.top) / rect.height - .5;
    stage.style.setProperty("--tilt-y", `${xRatio * 5}deg`);
    stage.style.setProperty("--tilt-x", `${yRatio * -4}deg`);
  }

  function resetTilt() {
    stageRef.current?.style.setProperty("--tilt-y", "0deg");
    stageRef.current?.style.setProperty("--tilt-x", "0deg");
  }

  const selectedRelationships = networkLinks.filter(
    (link) => link.source === selectedId || link.target === selectedId,
  );

  return (
    <section className="compatibility-shell">
      <header className="compatibility-heading">
        <div>
          <p className="eyebrow">Product relationship explorer</p>
          <h2>Follow the compatibility chain</h2>
          <p>Start at OHAUS, choose a product family, and drill into series, models, and verified part relationships.</p>
        </div>
        <div className="web-actions">
          <button onClick={goBack} disabled={path.length === 1}>← Back</button>
          <button className="reset-web" onClick={resetWeb}>Center on OHAUS</button>
        </div>
      </header>

      <nav className="web-breadcrumb" aria-label="Selected compatibility path">
        {path.map((nodeId, index) => {
          const node = nodeMap.get(nodeId);
          if (!node) return null;
          return (
            <span key={nodeId}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button onClick={() => { setPath(path.slice(0, index + 1)); setSelectedId(nodeId); }}>{node.label}</button>
            </span>
          );
        })}
      </nav>

      <div className="compatibility-layout">
        <div className="network-viewport" onPointerMove={handlePointerMove} onPointerLeave={resetTilt}>
          <div
            ref={stageRef}
            className="network-stage"
            role="group"
            aria-label="Interactive OHAUS product compatibility network"
          >
            <canvas ref={canvasRef} aria-hidden="true" />
            {positionedNodes.map((node) => {
              const onPath = path.includes(node.id);
              const isSelected = selectedId === node.id;
              const nodeDepth = node.kind === "root" ? 80 : node.kind === "family" ? 38 : node.kind === "part" ? 76 : 55;
              const nodeStyle = {
                left: `${node.x}%`,
                top: `${node.y}%`,
                "--node-z": `${nodeDepth}px`,
              } as CSSProperties;
              return (
                <button
                  key={node.id}
                  className={`web-node ${node.kind} ${node.relationState ?? ""} ${onPath ? "on-path" : ""} ${isSelected ? "selected" : ""}`}
                  style={nodeStyle}
                  onClick={() => selectNode(node)}
                  aria-pressed={isSelected}
                >
                  <small>{node.kind === "root" ? "COMPATIBILITY WEB" : node.kind}</small>
                  <strong>{node.label}</strong>
                </button>
              );
            })}
          </div>
          <p className="network-hint">Move to tilt · Select a node to follow its branch</p>
        </div>

        <aside className="web-detail" aria-live="polite">
          <p className="panel-label">Selected {selectedNode.kind}</p>
          <h3>{selectedNode.label}</h3>
          <p>{selectedNode.detail}</p>
          <div className="detail-status">
            <span className={selectedNode.verified ? "verified" : "planned"} aria-hidden="true" />
            {selectedNode.verified ? "Verified relationship data" : "Structure ready · links pending verification"}
          </div>

          {selectedRelationships.length > 0 && (
            <div className="relationship-list">
              <p className="panel-label">Direct relationships</p>
              {selectedRelationships.map((link) => {
                const otherId = link.source === selectedId ? link.target : link.source;
                const otherNode = nodeMap.get(otherId);
                return (
                  <button key={`${link.source}-${link.target}`} onClick={() => otherNode && setSelectedId(otherNode.id)}>
                    <span className={`relation-dot ${link.state}`} aria-hidden="true" />
                    <span><strong>{otherNode?.label}</strong><small>{link.label}</small></span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="relationship-legend">
            <p className="panel-label">Relationship key</p>
            <span><i className="relation-dot compatible" /> Compatible</span>
            <span><i className="relation-dot incompatible" /> Not compatible</span>
            <span><i className="relation-dot discontinued" /> Discontinued</span>
          </div>
        </aside>
      </div>
    </section>
  );
}

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
  const isCompatibilityMode = mode === "compatibility";
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
    <main className={`app-shell ${isSalesMode ? "sales-mode" : isCompatibilityMode ? "web-mode" : "tolerance-mode"}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">O</div>
          <div>
            <p className="eyebrow">{isCompatibilityMode ? "Product relationships" : isSalesMode ? "Internal sales support" : "Service reference"}</p>
            <h1>{isCompatibilityMode ? "Compatibility Web" : isSalesMode ? "Sales Assistant" : "Tolerance Assistant"}</h1>
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
          <button
            className={isCompatibilityMode ? "active" : ""}
            onClick={() => switchMode("compatibility")}
            aria-pressed={isCompatibilityMode}
          >
            <span className="mode-icon" aria-hidden="true">◎</span>
            3D Web
          </button>
        </nav>

        <div className="header-actions">
          {!isCompatibilityMode && <button className="clear-button" onClick={clearConversation}>Clear chat</button>}
          <div className="header-status">
            <span className="status-dot" aria-hidden="true" />
            {isCompatibilityMode ? "Verified links only" : isSalesMode ? "Sales pilot" : "Verified local data"}
          </div>
        </div>
      </header>

      {isCompatibilityMode ? (
        <CompatibilityWeb />
      ) : (
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
      )}
    </main>
  );
}
