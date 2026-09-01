"use client";

import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useEffect,
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
type SceneEdge = {
  key: string;
  source: string;
  target: string;
  relationType?: RelationType;
};
type ConnectionItem = {
  node: WebNode;
  relationType?: RelationType;
};

const initialPath = ["ohaus"];
const pageSize = 12;
const worldCenter = { x: 2100, y: 1600 };
const worldSize = { width: 4200, height: 3200 };

function relationLabel(type: RelationType) {
  return type === "accessory" ? "Accessory" : "Spare part";
}

function edgeKey(source: string, target: string, relationType?: RelationType) {
  return `${source}|${target}|${relationType ?? "hierarchy"}`;
}

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function findOpenPosition(
  anchor: Point,
  baseAngle: number,
  index: number,
  total: number,
  occupied: Map<string, Point>,
) {
  const spread = total <= 1 ? 0 : Math.min(250, Math.max(70, (total - 1) * 18));
  const offset = total <= 1 ? 0 : -spread / 2 + spread * (index / (total - 1));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const angle = (baseAngle + offset + attempt * 19) * Math.PI / 180;
    const radius = 285 + Math.floor(attempt / 6) * 95 + Math.floor(index / pageSize) * 90;
    const point = {
      x: Math.max(120, Math.min(worldSize.width - 120, anchor.x + Math.cos(angle) * radius)),
      y: Math.max(120, Math.min(worldSize.height - 120, anchor.y + Math.sin(angle) * radius)),
    };
    if ([...occupied.values()].every((existing) => distanceBetween(existing, point) >= 128)) return point;
  }
  return {
    x: Math.max(120, Math.min(worldSize.width - 120, anchor.x + (index + 1) * 145)),
    y: Math.max(120, Math.min(worldSize.height - 120, anchor.y + 300)),
  };
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
  const [path, setPath] = useState(initialPath);
  const [selectedId, setSelectedId] = useState("ohaus");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("accessory");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sceneNodeIds, setSceneNodeIds] = useState<Set<string>>(() => new Set());
  const [sceneEdges, setSceneEdges] = useState<SceneEdge[]>([]);
  const [positions, setPositions] = useState<Map<string, Point>>(() => new Map());
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef<Map<string, Point>>(new Map());
  const pointerRef = useRef({ pointerId: -1, x: 0, y: 0 });
  const initializedRef = useRef(false);

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
  const selectedNode = nodeMap.get(selectedId);

  const allRelationships = useMemo(() => {
    if (!data) return [];
    return data.links.filter((link) => link.source === selectedId || link.target === selectedId);
  }, [data, selectedId]);

  const filteredRelationships = useMemo(
    () => allRelationships.filter((link) => relationFilter === "all" || link.relationType === relationFilter),
    [allRelationships, relationFilter],
  );

  const children = useMemo(
    () => (data?.nodes ?? []).filter((node) => node.parentId === selectedId),
    [data, selectedId],
  );

  const graphItems = allRelationships.length > 0 ? filteredRelationships : children;
  const pageCount = Math.max(1, Math.ceil(graphItems.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !data) return [];
    return data.nodes
      .filter((node) => node.kind === "model" || node.kind === "part")
      .filter((node) => [node.label, node.materialNumber, node.productName, node.family]
        .some((value) => value?.toLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [data, query]);

  const sceneNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => sceneNodeIds.has(node.id) && positions.has(node.id)),
    [data, positions, sceneNodeIds],
  );

  useEffect(() => {
    if (!data || initializedRef.current) return;
    initializedRef.current = true;
    const nextPositions = new Map<string, Point>([["ohaus", worldCenter]]);
    const familyNodes = data.nodes.filter((node) => node.parentId === "ohaus");
    familyNodes.forEach((node, index) => {
      const angle = (-90 + index * (360 / Math.max(familyNodes.length, 1))) * Math.PI / 180;
      nextPositions.set(node.id, {
        x: worldCenter.x + Math.cos(angle) * 330,
        y: worldCenter.y + Math.sin(angle) * 330,
      });
    });
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
    setSceneNodeIds(new Set(["ohaus", ...familyNodes.map((node) => node.id)]));
    setSceneEdges(familyNodes.map((node) => ({
      key: edgeKey("ohaus", node.id),
      source: "ohaus",
      target: node.id,
    })));
    window.requestAnimationFrame(() => centerOnNode("ohaus"));
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    function drawNetwork() {
      if (!canvas || !stage) return;
      const rect = stage.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      sceneEdges.forEach((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return;
        const startX = source.x + pan.x;
        const startY = source.y + pan.y;
        const endX = target.x + pan.x;
        const endY = target.y + pan.y;
        const color = edge.relationType === "accessory"
          ? "rgba(53, 217, 145, .88)"
          : edge.relationType === "spare_part"
            ? "rgba(104, 170, 255, .86)"
            : "rgba(226, 59, 91, .52)";
        context.beginPath();
        context.moveTo(startX, startY);
        context.quadraticCurveTo((startX + endX) / 2, (startY + endY) / 2 - 13, endX, endY);
        context.strokeStyle = color;
        context.lineWidth = edge.relationType ? 2 : 1.25;
        context.shadowBlur = edge.relationType ? 9 : 4;
        context.shadowColor = color;
        context.stroke();
        context.shadowBlur = 0;
      });
    }
    const observer = new ResizeObserver(drawNetwork);
    observer.observe(stage);
    drawNetwork();
    return () => observer.disconnect();
  }, [pan, positions, sceneEdges]);

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

  function getConnections(nodeId: string, filter: RelationFilter): ConnectionItem[] {
    const relationships = data.links.filter((link) => link.source === nodeId || link.target === nodeId);
    if (relationships.length > 0) {
      return relationships
        .filter((link) => filter === "all" || link.relationType === filter)
        .map((link) => ({
          node: nodeMap.get(link.source === nodeId ? link.target : link.source),
          relationType: link.relationType,
        }))
        .filter((item): item is ConnectionItem => Boolean(item.node));
    }
    return data.nodes
      .filter((node) => node.parentId === nodeId)
      .map((node) => ({ node }));
  }

  function addPathToScene(node: WebNode, nextPositions: Map<string, Point>, nextIds: Set<string>, nextEdges: Map<string, SceneEdge>) {
    if (node.kind === "part" && !nextPositions.has(node.id)) {
      const relation = data.links.find((link) => link.target === node.id);
      const sourceNode = relation ? nodeMap.get(relation.source) : undefined;
      if (relation && sourceNode) {
        addPathToScene(sourceNode, nextPositions, nextIds, nextEdges);
        const sourcePoint = nextPositions.get(sourceNode.id) ?? worldCenter;
        const baseAngle = Math.atan2(sourcePoint.y - worldCenter.y, sourcePoint.x - worldCenter.x) * 180 / Math.PI;
        nextPositions.set(node.id, findOpenPosition(sourcePoint, baseAngle, 0, 1, nextPositions));
        nextIds.add(node.id);
        const key = edgeKey(sourceNode.id, node.id, relation.relationType);
        nextEdges.set(key, { key, source: sourceNode.id, target: node.id, relationType: relation.relationType });
        return;
      }
    }
    const ancestry = pathToNode(node.id);
    ancestry.forEach((nodeId, index) => {
      const pathNode = nodeMap.get(nodeId);
      if (!pathNode) return;
      nextIds.add(nodeId);
      if (index === 0) {
        if (!nextPositions.has(nodeId)) nextPositions.set(nodeId, worldCenter);
        return;
      }
      const parentId = ancestry[index - 1];
      const parentPoint = nextPositions.get(parentId) ?? worldCenter;
      if (!nextPositions.has(nodeId)) {
        const parentDirection = Math.atan2(parentPoint.y - worldCenter.y, parentPoint.x - worldCenter.x) * 180 / Math.PI;
        nextPositions.set(nodeId, findOpenPosition(parentPoint, parentDirection || -90, index, ancestry.length, nextPositions));
      }
      nextEdges.set(edgeKey(parentId, nodeId), {
        key: edgeKey(parentId, nodeId),
        source: parentId,
        target: nodeId,
      });
    });
  }

  function revealConnections(node: WebNode, filter: RelationFilter, pageIndex: number) {
    const connections = getConnections(node.id, filter);
    const pageItems = connections.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const nextPositions = new Map(positionsRef.current);
    const nextIds = new Set(sceneNodeIds);
    const nextEdges = new Map(sceneEdges.map((edge) => [edge.key, edge]));
    addPathToScene(node, nextPositions, nextIds, nextEdges);
    const parentPoint = nextPositions.get(node.id) ?? worldCenter;
    const baseAngle = node.id === "ohaus"
      ? -90
      : Math.atan2(parentPoint.y - worldCenter.y, parentPoint.x - worldCenter.x) * 180 / Math.PI;
    pageItems.forEach((item, pageItemIndex) => {
      const globalIndex = pageIndex * pageSize + pageItemIndex;
      nextIds.add(item.node.id);
      if (!nextPositions.has(item.node.id)) {
        nextPositions.set(
          item.node.id,
          findOpenPosition(parentPoint, baseAngle, globalIndex, connections.length, nextPositions),
        );
      }
      const source = node.id;
      const target = item.node.id;
      const key = edgeKey(source, target, item.relationType);
      nextEdges.set(key, { key, source, target, relationType: item.relationType });
    });
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
    setSceneNodeIds(nextIds);
    setSceneEdges([...nextEdges.values()]);
  }

  function focusNode(node: WebNode, center = false) {
    const nodeRelationships = data.links.filter((link) => link.source === node.id || link.target === node.id);
    let nextFilter = relationFilter;
    if (nodeRelationships.length > 0 && !nodeRelationships.some((link) => relationFilter === "all" || link.relationType === relationFilter)) {
      nextFilter = nodeRelationships[0].relationType;
      setRelationFilter(nextFilter);
    }
    setSelectedId(node.id);
    setPage(0);
    setQuery("");
    if (node.kind !== "part") setPath(pathToNode(node.id));
    revealConnections(node, nextFilter, 0);
    if (center) window.requestAnimationFrame(() => centerOnNode(node.id));
  }

  function centerOnNode(nodeId: string) {
    const stage = stageRef.current;
    const point = positionsRef.current.get(nodeId);
    if (!stage || !point) return;
    const rect = stage.getBoundingClientRect();
    setPan({ x: rect.width / 2 - point.x, y: rect.height / 2 - point.y });
  }

  function goBack() {
    if (selectedNode.kind === "part") {
      const category = nodeMap.get("portable-balances");
      if (category) focusNode(category, true);
      return;
    }
    if (path.length <= 1) return;
    const nextPath = path.slice(0, -1);
    const parent = nodeMap.get(nextPath[nextPath.length - 1]);
    setPath(nextPath);
    setSelectedId(nextPath[nextPath.length - 1]);
    setPage(0);
    if (parent) window.requestAnimationFrame(() => centerOnNode(parent.id));
  }

  function resetWeb() {
    initializedRef.current = true;
    const familyNodes = data.nodes.filter((node) => node.parentId === "ohaus");
    const nextPositions = new Map<string, Point>([["ohaus", worldCenter]]);
    familyNodes.forEach((node, index) => {
      const angle = (-90 + index * (360 / Math.max(familyNodes.length, 1))) * Math.PI / 180;
      nextPositions.set(node.id, {
        x: worldCenter.x + Math.cos(angle) * 330,
        y: worldCenter.y + Math.sin(angle) * 330,
      });
    });
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
    setSceneNodeIds(new Set(["ohaus", ...familyNodes.map((node) => node.id)]));
    setSceneEdges(familyNodes.map((node) => ({
      key: edgeKey("ohaus", node.id),
      source: "ohaus",
      target: node.id,
    })));
    setPath(initialPath);
    setSelectedId("ohaus");
    setRelationFilter("accessory");
    setPage(0);
    setQuery("");
    window.requestAnimationFrame(() => centerOnNode("ohaus"));
  }

  function changePage(nextPage: number) {
    setPage(nextPage);
    revealConnections(selectedNode, relationFilter, nextPage);
  }

  function changeRelationFilter(nextFilter: RelationFilter) {
    setRelationFilter(nextFilter);
    setPage(0);
    revealConnections(selectedNode, nextFilter, 0);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    pointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) return;
    if (pointerRef.current.pointerId === event.pointerId) {
      const dx = event.clientX - pointerRef.current.x;
      const dy = event.clientY - pointerRef.current.y;
      pointerRef.current.x = event.clientX;
      pointerRef.current.y = event.clientY;
      setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
      return;
    }
    const rect = stage.getBoundingClientRect();
    stage.style.setProperty("--tilt-y", `${((event.clientX - rect.left) / rect.width - .5) * 5}deg`);
    stage.style.setProperty("--tilt-x", `${((event.clientY - rect.top) / rect.height - .5) * -4}deg`);
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerRef.current.pointerId !== event.pointerId) return;
    pointerRef.current.pointerId = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
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

  return (
    <section className="compatibility-shell">
      <header className="compatibility-heading compatibility-heading-rich">
        <div>
          <p className="eyebrow">MMDF product relationship explorer</p>
          <h2>OHAUS Compatibility Web</h2>
          <p>Portable balances are fully mapped. The other original product families are ready as placeholders for future expansion.</p>
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
                <button key={node.id} onClick={() => focusNode(node, true)}>
                  <span><strong>{node.label}</strong><small>{node.kind} · {node.family}</small></span>
                  {node.materialNumber && <b>{node.materialNumber}</b>}
                </button>
              )) : <p>No portable balance item matches that search.</p>}
            </div>
          )}
        </div>
        <div className="web-actions">
          <button onClick={goBack} disabled={path.length === 1 && selectedNode.kind !== "part"}>← Back</button>
          <button className="reset-web" onClick={resetWeb}>Center on OHAUS</button>
        </div>
      </div>

      <nav className="web-breadcrumb" aria-label="Selected compatibility path">
        {path.map((nodeId, index) => {
          const node = nodeMap.get(nodeId);
          if (!node) return null;
          return (
            <span key={nodeId}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button onClick={() => focusNode(node, true)}>{node.label}</button>
            </span>
          );
        })}
        {selectedNode.kind === "part" && <span><i aria-hidden="true">›</i><button>{selectedNode.label}</button></span>}
      </nav>

      <div className="compatibility-layout">
        <div className="network-viewport">
          <div
            ref={stageRef}
            className={`network-stage branching-stage ${isDragging ? "dragging" : ""}`}
            role="group"
            aria-label="Portable balance compatibility network"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onPointerLeave={(event) => {
              if (pointerRef.current.pointerId === event.pointerId) stopDragging(event);
              stageRef.current?.style.setProperty("--tilt-y", "0deg");
              stageRef.current?.style.setProperty("--tilt-x", "0deg");
            }}
          >
            <canvas ref={canvasRef} aria-hidden="true" />
            <div
              className="network-scene"
              style={{
                width: worldSize.width,
                height: worldSize.height,
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
              }}
            >
              {sceneNodes.map((node) => {
                const point = positions.get(node.id) as Point;
                const relationship = sceneEdges.find((edge) => edge.target === node.id && edge.relationType);
                const isSelected = selectedId === node.id;
                const nodeStyle = {
                  left: point.x,
                  top: point.y,
                  "--node-z": isSelected ? "82px" : node.kind === "part" ? "68px" : "54px",
                } as CSSProperties;
                return (
                  <button
                    key={node.id}
                    className={`web-node ${node.kind} ${relationship?.relationType ?? ""} ${isSelected ? "selected" : ""} ${path.includes(node.id) ? "on-path" : ""}`}
                    style={nodeStyle}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => focusNode(node)}
                    aria-pressed={isSelected}
                  >
                    <small>{isSelected ? `selected ${node.kind}` : relationship?.relationType ? relationLabel(relationship.relationType) : node.kind}</small>
                    <strong>{node.label}</strong>
                    {node.materialNumber && <em>{node.materialNumber}</em>}
                  </button>
                );
              })}
            </div>
          </div>

          {graphItems.length > pageSize && (
            <div className="web-pagination">
              <button disabled={safePage === 0} onClick={() => changePage(Math.max(0, safePage - 1))}>←</button>
              <span>{safePage + 1} / {pageCount}</span>
              <button disabled={safePage + 1 >= pageCount} onClick={() => changePage(Math.min(pageCount - 1, safePage + 1))}>→</button>
            </div>
          )}
          <p className="network-hint">Move to tilt · Drag empty space to move · Select any node to branch · {graphItems.length} connected item{graphItems.length === 1 ? "" : "s"}</p>
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

          <div className="detail-status">
            <span className={selectedNode.verified ? "verified" : "planned"} aria-hidden="true" />
            {selectedNode.verified
              ? "Matched to an MMDF catalog row"
              : selectedNode.kind === "part"
                ? "Referenced in MMDF · catalog row missing"
                : "Placeholder family · catalog expansion pending"}
          </div>

          {allRelationships.length > 0 && (
            <>
              <div className="web-relation-tabs" aria-label="Relationship type">
                {([
                  ["accessory", `Accessories ${relationshipCounts.accessory}`],
                  ["spare_part", `Spare parts ${relationshipCounts.spare_part}`],
                  ["all", `All ${allRelationships.length}`],
                ] as Array<[RelationFilter, string]>).map(([value, label]) => (
                  <button key={value} className={relationFilter === value ? "active" : ""} onClick={() => changeRelationFilter(value)}>{label}</button>
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
                      <button key={`${link.source}-${link.target}-${link.relationType}`} onClick={() => focusNode(otherNode, true)}>
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
