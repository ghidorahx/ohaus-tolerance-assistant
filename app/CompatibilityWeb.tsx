"use client";

/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- The canvas uses the ARIA application pattern so pointer and keyboard panning share one focusable viewport. */

import {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

type NodeKind = "root" | "family" | "category" | "series" | "model" | "part";
type RelationType = "accessory" | "spare_part";
type RelationFilter = "all" | RelationType;

type WebNode = {
  id: string;
  label: string;
  kind: NodeKind;
  detail: string;
  parentId: string | null;
  family?: string;
  parentFamily?: string;
  materialNumber?: string;
  productName?: string;
  imageUrl?: string;
  sourceRow?: number | null;
  modelCount?: number;
  verified: boolean;
  specifications?: {
    maximumCapacity?: string;
    readability?: string;
    stabilizationTime?: string;
    power?: string;
    batteryLife?: string;
    panConstruction?: string;
    dimensions?: string;
  };
  relationshipCounts?: Record<RelationType, number>;
};

type WebLink = {
  source: string;
  target: string;
  state: "compatible";
  relationType: RelationType;
  label: string;
  sourceField: string;
};

type WebData = {
  metadata: {
    sourceFile: string;
    sourceSha256: string;
    selectionRule: string;
    portableProducts: number;
    portableFamilies: number;
    uniqueRelatedParts: number;
    resolvedParts: number;
    unresolvedParts: number;
    accessoryLinks: number;
    sparePartLinks: number;
    relationshipLinks: number;
  };
  nodes: WebNode[];
  links: WebLink[];
};

type Point = { x: number; y: number };
type ViewState = Point & { scale: number };

const WORLD_WIDTH = 8000;
const WORLD_HEIGHT = 5200;
const initialPath = ["ohaus", "balances-scales", "portable-balances"];
const initialExpanded = new Set(initialPath);

function relationLabel(type: RelationType) {
  return type === "accessory" ? "Accessory" : "Spare part";
}

function buildPositions(nodes: WebNode[]) {
  const positions = new Map<string, Point>([
    ["ohaus", { x: 4000, y: 230 }],
    ["balances-scales", { x: 4000, y: 500 }],
    ["portable-balances", { x: 4000, y: 790 }],
  ]);
  const series = nodes.filter((node) => node.kind === "series").sort((a, b) => a.label.localeCompare(b.label));
  const laneWidth = 7000 / Math.max(series.length, 1);

  series.forEach((seriesNode, seriesIndex) => {
    const seriesX = 500 + laneWidth * (seriesIndex + 0.5);
    positions.set(seriesNode.id, { x: seriesX, y: 1110 });
    const models = nodes
      .filter((node) => node.kind === "model" && node.parentId === seriesNode.id)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    models.forEach((model, modelIndex) => {
      const column = modelIndex % 3;
      const row = Math.floor(modelIndex / 3);
      positions.set(model.id, {
        x: seriesX + (column - 1) * Math.min(250, laneWidth * 0.26),
        y: 1420 + row * 165,
      });
    });
  });

  const parts = nodes
    .filter((node) => node.kind === "part")
    .sort((a, b) => `${a.parentFamily ?? ""} ${a.family ?? ""} ${a.label}`.localeCompare(`${b.parentFamily ?? ""} ${b.family ?? ""} ${b.label}`, undefined, { numeric: true }));
  const partColumns = 12;
  const partGap = (WORLD_WIDTH - 900) / (partColumns - 1);
  parts.forEach((part, index) => {
    positions.set(part.id, {
      x: 450 + (index % partColumns) * partGap,
      y: 3100 + Math.floor(index / partColumns) * 210,
    });
  });

  return positions;
}

function CompatibilityWebLoading({ error }: { error?: string }) {
  return (
    <section className="compatibility-shell compatibility-loading">
      <p className="eyebrow">Portable balances</p>
      <h2>{error ? "The compatibility data could not be loaded" : "Loading the compatibility web…"}</h2>
      <p>{error ?? "Preparing verified products, accessories, and spare parts from the MMDF master workbook."}</p>
    </section>
  );
}

export default function CompatibilityWeb() {
  const [data, setData] = useState<WebData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(initialExpanded));
  const [selectedId, setSelectedId] = useState("portable-balances");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("accessory");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewState>({ x: -950, y: -60, scale: 0.48 });
  const [isDragging, setIsDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ pointerId: -1, x: 0, y: 0 });
  const hasFittedInitialView = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch("./data/portable-balance-web.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Compatibility data returned ${response.status}.`);
        return response.json() as Promise<WebData>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unknown data error.");
      });
    return () => { cancelled = true; };
  }, []);

  const nodeMap = useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.id, node])),
    [data],
  );
  const positions = useMemo(() => buildPositions(data?.nodes ?? []), [data]);
  const selectedNode = nodeMap.get(selectedId);

  const visibleIds = useMemo(() => {
    const visible = new Set(expandedIds);
    if (!data) return visible;
    data.nodes.forEach((node) => {
      if (node.parentId && expandedIds.has(node.parentId)) visible.add(node.id);
    });
    data.links.forEach((link) => {
      if (expandedIds.has(link.source) || expandedIds.has(link.target)) {
        visible.add(link.source);
        visible.add(link.target);
      }
    });
    return visible;
  }, [data, expandedIds]);

  const visibleNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => visibleIds.has(node.id) && positions.has(node.id)),
    [data, positions, visibleIds],
  );

  const visibleEdges = useMemo(() => {
    if (!data) return [];
    const hierarchy = data.nodes
      .filter((node) => node.parentId && expandedIds.has(node.parentId) && visibleIds.has(node.id))
      .map((node) => ({ source: node.parentId as string, target: node.id, relationType: null as RelationType | null }));
    const relationships = data.links
      .filter((link) => (expandedIds.has(link.source) || expandedIds.has(link.target)) && visibleIds.has(link.source) && visibleIds.has(link.target))
      .map((link) => ({ source: link.source, target: link.target, relationType: link.relationType }));
    return [...hierarchy, ...relationships];
  }, [data, expandedIds, visibleIds]);

  const allRelationships = useMemo(() => {
    if (!data) return [];
    return data.links.filter((link) => link.source === selectedId || link.target === selectedId);
  }, [data, selectedId]);

  const filteredRelationships = useMemo(
    () => allRelationships.filter((link) => relationFilter === "all" || link.relationType === relationFilter),
    [allRelationships, relationFilter],
  );

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !data) return [];
    return data.nodes
      .filter((node) => node.kind === "model" || node.kind === "part")
      .filter((node) => [node.label, node.materialNumber, node.productName, node.family]
        .some((value) => value?.toLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [data, query]);

  const fitPoints = useCallback((nodeIds = [...visibleIds]) => {
    const viewport = viewportRef.current;
    const points = nodeIds.map((id) => positions.get(id)).filter((point): point is Point => Boolean(point));
    if (!viewport || points.length === 0) return;
    const rect = viewport.getBoundingClientRect();
    const minX = Math.min(...points.map((point) => point.x)) - 130;
    const maxX = Math.max(...points.map((point) => point.x)) + 130;
    const minY = Math.min(...points.map((point) => point.y)) - 130;
    const maxY = Math.max(...points.map((point) => point.y)) + 130;
    const scale = Math.max(0.16, Math.min(1.25, (rect.width - 90) / (maxX - minX), (rect.height - 90) / (maxY - minY)));
    setView({
      x: rect.width / 2 - ((minX + maxX) / 2) * scale,
      y: rect.height / 2 - ((minY + maxY) / 2) * scale,
      scale,
    });
  }, [positions, visibleIds]);

  useEffect(() => {
    if (!data || hasFittedInitialView.current) return;
    hasFittedInitialView.current = true;
    const initialVisible = data.nodes
      .filter((node) => initialExpanded.has(node.id) || (node.parentId && initialExpanded.has(node.parentId)))
      .map((node) => node.id);
    const frame = window.requestAnimationFrame(() => fitPoints(initialVisible));
    return () => window.cancelAnimationFrame(frame);
  }, [data, fitPoints]);

  if (!data || !selectedNode) return <CompatibilityWebLoading error={loadError || undefined} />;

  function pathToNode(nodeId: string) {
    const nextPath: string[] = [];
    let current = nodeMap.get(nodeId);
    while (current) {
      nextPath.unshift(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    return nextPath;
  }

  function focusNode(node: WebNode) {
    const ancestry = pathToNode(node.id);
    setExpandedIds((current) => {
      const next = new Set(current);
      ancestry.forEach((id) => next.add(id));
      next.add(node.id);
      return next;
    });
    setSelectedId(node.id);
    setQuery("");
  }

  function resetWeb() {
    setExpandedIds(new Set(initialExpanded));
    setSelectedId("portable-balances");
    setRelationFilter("accessory");
    setQuery("");
    const resetIds = data.nodes
      .filter((node) => initialExpanded.has(node.id) || (node.parentId && initialExpanded.has(node.parentId)))
      .map((node) => node.id);
    window.requestAnimationFrame(() => fitPoints(resetIds));
  }

  function panToNode(nodeId: string) {
    const viewport = viewportRef.current;
    const point = positions.get(nodeId);
    if (!viewport || !point) return;
    const rect = viewport.getBoundingClientRect();
    setView((current) => ({
      ...current,
      x: rect.width / 2 - point.x * current.scale,
      y: rect.height / 2 - point.y * current.scale,
    }));
  }

  function handleSearchResult(node: WebNode) {
    focusNode(node);
    window.requestAnimationFrame(() => panToNode(node.id));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    pointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerRef.current.pointerId !== event.pointerId) return;
    const dx = event.clientX - pointerRef.current.x;
    const dy = event.clientY - pointerRef.current.y;
    pointerRef.current.x = event.clientX;
    pointerRef.current.y = event.clientY;
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerRef.current.pointerId !== event.pointerId) return;
    pointerRef.current.pointerId = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    setView((current) => {
      const nextScale = Math.max(0.16, Math.min(1.6, current.scale * Math.exp(-event.deltaY * 0.0012)));
      const worldX = (cursorX - current.x) / current.scale;
      const worldY = (cursorY - current.y) / current.scale;
      return {
        x: cursorX - worldX * nextScale,
        y: cursorY - worldY * nextScale,
        scale: nextScale,
      };
    });
  }

  function zoomBy(factor: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    setView((current) => {
      const nextScale = Math.max(0.16, Math.min(1.6, current.scale * factor));
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        x: centerX - worldX * nextScale,
        y: centerY - worldY * nextScale,
        scale: nextScale,
      };
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const amount = event.shiftKey ? 140 : 70;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
    }
    if (event.key === "ArrowLeft") setView((current) => ({ ...current, x: current.x + amount }));
    if (event.key === "ArrowRight") setView((current) => ({ ...current, x: current.x - amount }));
    if (event.key === "ArrowUp") setView((current) => ({ ...current, y: current.y + amount }));
    if (event.key === "ArrowDown") setView((current) => ({ ...current, y: current.y - amount }));
    if (event.key === "+" || event.key === "=") zoomBy(1.2);
    if (event.key === "-") zoomBy(1 / 1.2);
    if (event.key === "0") fitPoints();
  }

  const relationshipCounts = {
    accessory: allRelationships.filter((link) => link.relationType === "accessory").length,
    spare_part: allRelationships.filter((link) => link.relationType === "spare_part").length,
  };
  const detailSpecs = selectedNode.specifications
    ? [
      ["Capacity", selectedNode.specifications.maximumCapacity],
      ["Readability", selectedNode.specifications.readability],
      ["Power", selectedNode.specifications.power],
      ["Battery", selectedNode.specifications.batteryLife],
      ["Stabilization", selectedNode.specifications.stabilizationTime],
      ["Dimensions", selectedNode.specifications.dimensions],
    ].filter(([, value]) => value)
    : [];
  const selectedPath = pathToNode(selectedNode.id);

  return (
    <section className="compatibility-shell">
      <header className="compatibility-heading compatibility-heading-rich">
        <div>
          <p className="eyebrow">MMDF product relationship explorer</p>
          <h2>Portable Balance Compatibility Web</h2>
          <p>Click to keep expanding one continuous product web. Drag the canvas to move through it.</p>
        </div>
        <div className="web-catalog-stats" aria-label="Portable balance catalog coverage">
          <span><strong>{data.metadata.portableProducts}</strong> balances</span>
          <span><strong>{data.metadata.uniqueRelatedParts}</strong> parts</span>
          <span><strong>{data.metadata.relationshipLinks.toLocaleString()}</strong> links</span>
        </div>
      </header>

      <div className="web-toolbar">
        <div className="web-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find model, item number, or description"
            aria-label="Search portable balances and related parts"
          />
          {query && (
            <div className="web-search-results">
              {searchResults.length > 0 ? searchResults.map((node) => (
                <button key={node.id} onClick={() => handleSearchResult(node)}>
                  <span><strong>{node.label}</strong><small>{node.kind} · {node.family}</small></span>
                  {node.materialNumber && <b>{node.materialNumber}</b>}
                </button>
              )) : <p>No portable balance item matches that search.</p>}
            </div>
          )}
        </div>
        <div className="web-actions">
          <button onClick={() => fitPoints()}>Fit visible</button>
          <button className="reset-web" onClick={resetWeb}>Reset web</button>
        </div>
      </div>

      <nav className="web-breadcrumb" aria-label="Selected compatibility path">
        {selectedPath.length > 0 ? selectedPath.map((nodeId, index) => {
          const node = nodeMap.get(nodeId);
          if (!node) return null;
          return (
            <span key={nodeId}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button onClick={() => { focusNode(node); panToNode(node.id); }}>{node.label}</button>
            </span>
          );
        }) : <span><button>{selectedNode.label}</button></span>}
      </nav>

      <div className="compatibility-layout">
        <div
          ref={viewportRef}
          className={`network-viewport persistent-web ${isDragging ? "dragging" : ""}`}
          role="application"
          aria-label="Draggable portable balance compatibility web"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        >
          <div
            className="network-world"
            style={{
              width: WORLD_WIDTH,
              height: WORLD_HEIGHT,
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
            }}
          >
            {visibleEdges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              const dx = target.x - source.x;
              const dy = target.y - source.y;
              const distance = Math.hypot(dx, dy);
              const angle = Math.atan2(dy, dx) * 180 / Math.PI;
              const edgeStyle = {
                left: source.x,
                top: source.y,
                width: distance,
                transform: `rotate(${angle}deg)`,
              } as CSSProperties;
              return <i key={`${edge.source}-${edge.target}-${edge.relationType ?? "hierarchy"}`} className={`web-edge ${edge.relationType ?? "hierarchy"}`} style={edgeStyle} aria-hidden="true" />;
            })}

            {visibleNodes.map((node) => {
              const point = positions.get(node.id) as Point;
              const relatedType = node.kind === "part"
                ? data.links.find((link) => link.target === node.id && expandedIds.has(link.source))?.relationType
                : undefined;
              const nodeStyle = { left: point.x, top: point.y } as CSSProperties;
              return (
                <button
                  key={node.id}
                  className={`web-node ${node.kind} ${relatedType ?? ""} ${selectedId === node.id ? "selected" : ""} ${selectedPath.includes(node.id) ? "on-path" : ""} ${expandedIds.has(node.id) ? "expanded" : ""}`}
                  style={nodeStyle}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => focusNode(node)}
                  aria-pressed={selectedId === node.id}
                  title={`Expand ${node.label}`}
                >
                  <small>{expandedIds.has(node.id) ? "expanded" : relatedType ? relationLabel(relatedType) : node.kind}</small>
                  <strong>{node.label}</strong>
                  {node.materialNumber && <em>{node.materialNumber}</em>}
                </button>
              );
            })}
          </div>

          <div className="web-camera-controls" aria-label="Web view controls">
            <button onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
            <button onPointerDown={(event) => event.stopPropagation()} onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
          </div>
          <p className="network-hint">Drag to move · Scroll to zoom · Click a node to keep branching · {visibleNodes.length} nodes visible</p>
        </div>

        <aside className="web-detail" aria-live="polite">
          <p className="panel-label">Selected {selectedNode.kind}</p>
          <h3>{selectedNode.label}</h3>
          {selectedNode.materialNumber && <p className="web-material-number">Item {selectedNode.materialNumber}</p>}
          <p>{selectedNode.detail}</p>

          {detailSpecs.length > 0 && (
            <div className="web-spec-grid">
              {detailSpecs.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
            </div>
          )}

          <button className="web-expand-button" onClick={() => focusNode(selectedNode)}>
            {expandedIds.has(selectedNode.id) ? "Connections expanded" : "Expand connections"}
          </button>

          <div className="detail-status">
            <span className={selectedNode.verified ? "verified" : "planned"} aria-hidden="true" />
            {selectedNode.verified ? "Matched to an MMDF catalog row" : "Referenced in MMDF · catalog row missing"}
          </div>

          {allRelationships.length > 0 && (
            <>
              <div className="web-relation-tabs" aria-label="Relationship type">
                {([
                  ["accessory", `Accessories ${relationshipCounts.accessory}`],
                  ["spare_part", `Spare parts ${relationshipCounts.spare_part}`],
                  ["all", `All ${allRelationships.length}`],
                ] as Array<[RelationFilter, string]>).map(([value, label]) => (
                  <button key={value} className={relationFilter === value ? "active" : ""} onClick={() => setRelationFilter(value)}>{label}</button>
                ))}
              </div>

              <details className="web-relationship-details">
                <summary>Reference all {filteredRelationships.length} matching relationships</summary>
                <div className="relationship-list">
                  {filteredRelationships.map((link) => {
                    const otherId = link.source === selectedId ? link.target : link.source;
                    const otherNode = nodeMap.get(otherId);
                    if (!otherNode) return null;
                    return (
                      <button key={`${link.source}-${link.target}-${link.relationType}`} onClick={() => handleSearchResult(otherNode)}>
                        <span className={`relation-dot ${link.relationType}`} aria-hidden="true" />
                        <span><strong>{otherNode.label}</strong><small>{relationLabel(link.relationType)}</small></span>
                        {otherNode.materialNumber && <b>{otherNode.materialNumber}</b>}
                      </button>
                    );
                  })}
                </div>
              </details>
            </>
          )}

          <details className="web-source-trace">
            <summary>Workbook source</summary>
            <p><strong>{data.metadata.sourceFile}</strong></p>
            <p>{data.metadata.selectionRule}</p>
            {selectedNode.sourceRow && <p>Raw_Data row {selectedNode.sourceRow}</p>}
          </details>

          <div className="relationship-legend">
            <p className="panel-label">Relationship key</p>
            <span><i className="relation-dot accessory" /> Accessory</span>
            <span><i className="relation-dot spare_part" /> Spare part</span>
            <span><i className="relation-dot unresolved" /> Unresolved workbook reference</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
