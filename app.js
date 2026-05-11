const state = {
  projectId: uid(),
  analysisTime: 0,
  playing: false,
  activePlayerId: null,
  selectedAnnotationId: null,
  selectedTool: "select",
  currentDraft: null,
  interaction: null,
  contextMenu: null,
  players: [],
  annotations: [],
  tracks: [],
  lastTick: 0,
};

const els = {
  fileInput: document.querySelector("#fileInput"),
  playerGrid: document.querySelector("#playerGrid"),
  emptyState: document.querySelector("#emptyState"),
  playPause: document.querySelector("#playPause"),
  stepBack: document.querySelector("#stepBack"),
  stepForward: document.querySelector("#stepForward"),
  timeline: document.querySelector("#timeline"),
  timeReadout: document.querySelector("#timeReadout"),
  projectJson: document.querySelector("#projectJson"),
  exportCsv: document.querySelector("#exportCsv"),
  exportProject: document.querySelector("#exportProject"),
  contextMenu: document.querySelector("#contextMenu"),
  calibrateAction: document.querySelector("#calibrateAction"),
  reverseAngleAction: document.querySelector("#reverseAngleAction"),
  trackMarkerAction: document.querySelector("#trackMarkerAction"),
};

const DEFAULT_FPS = 30;
const EPSILON = 0.0001;

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function secondsLabel(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function analysisDuration() {
  if (!state.players.length) return 0;
  return Math.max(
    0,
    ...state.players.map((player) => {
      const out = Number.isFinite(player.sourceOut) ? player.sourceOut : player.duration;
      return Math.max(0, out - player.sourceIn - player.syncOffset);
    }),
  );
}

function sourceTimeFor(player, analysisTime = state.analysisTime) {
  const out = Number.isFinite(player.sourceOut) ? player.sourceOut : player.duration;
  return clamp(analysisTime + player.sourceIn + player.syncOffset, player.sourceIn, out);
}

function isPlayerInsideTrim(player, analysisTime = state.analysisTime) {
  const rawSourceTime = analysisTime + player.sourceIn + player.syncOffset;
  const out = Number.isFinite(player.sourceOut) ? player.sourceOut : player.duration;
  return rawSourceTime >= player.sourceIn && rawSourceTime <= out;
}

function syncVideoElement(player, shouldPlay = false) {
  if (!player.video) return;
  const target = sourceTimeFor(player);
  const tolerance = shouldPlay ? 0.09 : 0.015;
  if (Math.abs(player.video.currentTime - target) > tolerance) {
    player.video.currentTime = target;
  }

  if (shouldPlay && isPlayerInsideTrim(player)) {
    player.video.play().catch(() => {});
  } else {
    player.video.pause();
  }
}

function playerById(playerId) {
  return state.players.find((player) => player.id === playerId);
}

function activePlayer() {
  return playerById(state.activePlayerId) ?? state.players[0] ?? null;
}

function setActivePlayer(playerId) {
  state.activePlayerId = playerId;
  updateActivePlayerUI();
}

function updateActivePlayerUI() {
  els.playerGrid.querySelectorAll(".player-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.playerId === state.activePlayerId);
  });
}

function setTool(tool) {
  state.selectedTool = tool;
  state.currentDraft = null;
  state.interaction = null;
  updateToolUI();
  drawAllOverlays();
}

function updateToolUI() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.selectedTool);
  });
}

function videoContentRect(player, useCanvasPixels = false) {
  const canvas = player.canvas;
  const video = player.video;
  const rect = canvas.getBoundingClientRect();
  const width = useCanvasPixels ? canvas.width : rect.width;
  const height = useCanvasPixels ? canvas.height : rect.height;
  const videoWidth = video?.videoWidth || width;
  const videoHeight = video?.videoHeight || height;
  const containerAspect = width / height;
  const videoAspect = videoWidth / videoHeight;

  if (!Number.isFinite(videoAspect) || videoAspect <= 0) {
    return { x: 0, y: 0, width, height };
  }

  if (videoAspect > containerAspect) {
    const contentHeight = width / videoAspect;
    return { x: 0, y: (height - contentHeight) / 2, width, height: contentHeight };
  }

  const contentWidth = height * videoAspect;
  return { x: (width - contentWidth) / 2, y: 0, width: contentWidth, height };
}

function normalizedPoint(event, player) {
  const canvas = player.canvas;
  const rect = canvas.getBoundingClientRect();
  const content = videoContentRect(player, false);
  return {
    x: clamp((event.clientX - rect.left - content.x) / content.width, 0, 1),
    y: clamp((event.clientY - rect.top - content.y) / content.height, 0, 1),
  };
}

function denormalize(point, player) {
  const content = videoContentRect(player, true);
  return {
    x: content.x + point.x * content.width,
    y: content.y + point.y * content.height,
  };
}

function sourcePixelPoint(point, player) {
  const width = player.video?.videoWidth || player.canvas?.width || 1;
  const height = player.video?.videoHeight || player.canvas?.height || 1;
  return {
    x: point.x * width,
    y: point.y * height,
  };
}

function distancePixels(a, b, player) {
  const da = sourcePixelPoint(a, player);
  const db = sourcePixelPoint(b, player);
  return Math.hypot(db.x - da.x, db.y - da.y);
}

function distanceLabel(distancePx, player) {
  const calibration = player.calibration;
  if (calibration?.pixelsPerUnit && calibration?.unit && calibration.unit !== "px") {
    return `${(distancePx / calibration.pixelsPerUnit).toFixed(2)} ${calibration.unit}`;
  }
  return `${Math.round(distancePx)} px`;
}

function canvasDistance(a, b, player) {
  const da = denormalize(a, player);
  const db = denormalize(b, player);
  return Math.hypot(db.x - da.x, db.y - da.y);
}

function distanceToSegment(point, a, b, player) {
  const p = denormalize(point, player);
  const pa = denormalize(a, player);
  const pb = denormalize(b, player);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPSILON) return Math.hypot(p.x - pa.x, p.y - pa.y);
  const t = clamp(((p.x - pa.x) * dx + (p.y - pa.y) * dy) / lengthSq, 0, 1);
  const x = pa.x + t * dx;
  const y = pa.y + t * dy;
  return Math.hypot(p.x - x, p.y - y);
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
    center: {
      x: x + Math.abs(a.x - b.x) / 2,
      y: y + Math.abs(a.y - b.y) / 2,
    },
  };
}

function pointInsideRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function angleDegrees(a, b, c, player, invertSign = false) {
  const pa = sourcePixelPoint(a, player);
  const pb = sourcePixelPoint(b, player);
  const pc = sourcePixelPoint(c, player);
  const ab = { x: pa.x - pb.x, y: pa.y - pb.y };
  const cb = { x: pc.x - pb.x, y: pc.y - pb.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const cross = ab.x * cb.y - ab.y * cb.x;
  if (Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y) < EPSILON) return 0;
  let signed = (-Math.atan2(cross, dot) * 180) / Math.PI;
  if (invertSign) signed *= -1;
  return Math.abs(signed) < 0.05 ? 0 : signed;
}

function angleForAnnotation(annotation, player) {
  return angleDegrees(
    annotation.points[0],
    annotation.points[1],
    annotation.points[2],
    player,
    annotation.options?.invertAngleSign,
  );
}

function formatAngle(value) {
  const safe = Math.abs(value) < 0.05 ? 0 : value;
  return `${safe.toFixed(1)}°`;
}

function annotationsForFrame(playerId) {
  const frameTolerance = 1 / ((playerById(playerId)?.fps ?? DEFAULT_FPS) * 2);
  return state.annotations.filter(
    (annotation) =>
      annotation.playerId === playerId &&
      Math.abs(annotation.analysisTime - state.analysisTime) <= frameTolerance,
  );
}

function createAnnotation(player, type, points) {
  const annotation = {
    id: uid(),
    playerId: player.id,
    type,
    analysisTime: Number(state.analysisTime.toFixed(6)),
    sourceTime: Number(sourceTimeFor(player).toFixed(6)),
    points,
    options: type === "angle" ? { invertAngleSign: false } : {},
    metrics: {},
    label: `${type}-${state.annotations.length + 1}`,
  };
  annotation.metrics = measurementMetrics(player, type, points, annotation.options);
  state.annotations.push(annotation);
  updateExports();
  drawAllOverlays();
  return annotation;
}

function measurementMetrics(player, type, points, options = {}) {
  if (type === "line" && points.length >= 2) {
    const distancePx = Number(distancePixels(points[0], points[1], player).toFixed(3));
    const metrics = { distancePx };
    if (player.calibration?.pixelsPerUnit && player.calibration?.unit && player.calibration.unit !== "px") {
      metrics.distanceReal = Number((distancePx / player.calibration.pixelsPerUnit).toFixed(4));
      metrics.unit = player.calibration.unit;
    }
    return {
      ...metrics,
    };
  }

  if (type === "angle" && points.length >= 3) {
    return {
      angleDeg: Number(angleDegrees(points[0], points[1], points[2], player, options.invertAngleSign).toFixed(3)),
    };
  }

  return {};
}

function updateAnnotationMetrics(annotation, player = playerById(annotation.playerId)) {
  if (!annotation || !player) return;
  annotation.metrics = measurementMetrics(player, annotation.type, annotation.points, annotation.options);
  annotation.sourceTime = Number(sourceTimeFor(player, annotation.analysisTime).toFixed(6));
}

function refreshPlayerMeasurements(player) {
  state.annotations
    .filter((annotation) => annotation.playerId === player.id)
    .forEach((annotation) => updateAnnotationMetrics(annotation, player));
}

function createDefaultAnglePoints(center) {
  return [
    { x: clamp(center.x - 0.12, 0, 1), y: clamp(center.y + 0.08, 0, 1) },
    center,
    { x: clamp(center.x + 0.12, 0, 1), y: clamp(center.y + 0.08, 0, 1) },
  ];
}

function moveAnnotation(annotation, delta) {
  const minX = Math.min(...annotation.points.map((point) => point.x));
  const maxX = Math.max(...annotation.points.map((point) => point.x));
  const minY = Math.min(...annotation.points.map((point) => point.y));
  const maxY = Math.max(...annotation.points.map((point) => point.y));
  const dx = clamp(delta.x, -minX, 1 - maxX);
  const dy = clamp(delta.y, -minY, 1 - maxY);
  annotation.points = annotation.points.map((point) => ({
    x: point.x + dx,
    y: point.y + dy,
  }));
}

function annotationById(annotationId) {
  return state.annotations.find((annotation) => annotation.id === annotationId);
}

function hitTestAnnotation(player, point) {
  const hitRadius = 14 * (window.devicePixelRatio || 1);
  const bodyRadius = 10 * (window.devicePixelRatio || 1);
  const annotations = annotationsForFrame(player.id).slice().reverse();

  for (const annotation of annotations) {
    for (let index = 0; index < annotation.points.length; index++) {
      if (canvasDistance(point, annotation.points[index], player) <= hitRadius) {
        return { annotation, mode: "point", pointIndex: index };
      }
    }

    if (annotation.type === "line" && annotation.points.length >= 2) {
      if (distanceToSegment(point, annotation.points[0], annotation.points[1], player) <= bodyRadius) {
        return { annotation, mode: "body" };
      }
    }

    if (annotation.type === "trackbox" && annotation.points.length >= 2) {
      const rect = rectFromPoints(annotation.points[0], annotation.points[1]);
      if (pointInsideRect(point, rect)) return { annotation, mode: "body" };
    }

    if (annotation.type === "angle" && annotation.points.length >= 3) {
      const [a, b, c] = annotation.points;
      const nearArm = distanceToSegment(point, a, b, player) <= bodyRadius || distanceToSegment(point, b, c, player) <= bodyRadius;
      const nearCenter = canvasDistance(point, b, player) <= hitRadius * 1.5;
      if (nearArm || nearCenter) return { annotation, mode: "body" };
    }

    if (annotation.type === "marker" && annotation.points.length) {
      if (canvasDistance(point, annotation.points[0], player) <= hitRadius) {
        return { annotation, mode: "point", pointIndex: 0 };
      }
    }
  }

  return null;
}

function showContextMenu(event, player) {
  event.preventDefault();
  event.stopPropagation();
  const point = normalizedPoint(event, player);
  const hit = hitTestAnnotation(player, point);

  if (!hit || !["line", "angle", "marker", "trackbox"].includes(hit.annotation.type)) {
    hideContextMenu();
    return;
  }

  state.selectedAnnotationId = hit.annotation.id;
  state.contextMenu = {
    playerId: player.id,
    annotationId: hit.annotation.id,
  };
  els.contextMenu.style.left = `${event.clientX}px`;
  els.contextMenu.style.top = `${event.clientY}px`;
  els.calibrateAction.hidden = hit.annotation.type !== "line";
  els.reverseAngleAction.hidden = hit.annotation.type !== "angle";
  els.trackMarkerAction.hidden = !["marker", "trackbox"].includes(hit.annotation.type);
  els.contextMenu.hidden = false;
  drawAllOverlays();
}

function hideContextMenu() {
  state.contextMenu = null;
  els.contextMenu.hidden = true;
}

function calibrateSelectedLine() {
  const context = state.contextMenu;
  hideContextMenu();
  if (!context) return;

  const player = playerById(context.playerId);
  const annotation = annotationById(context.annotationId);
  if (!player || !annotation || annotation.type !== "line") return;

  const distancePx = distancePixels(annotation.points[0], annotation.points[1], player);
  const previous = player.calibration?.pixelsPerUnit
    ? (distancePx / player.calibration.pixelsPerUnit).toFixed(2)
    : "";
  const value = window.prompt("이 막대의 실제 길이를 입력하세요. 예: 50 cm", previous ? `${previous} ${player.calibration.unit}` : "10 cm");
  if (!value) return;

  const match = value.trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z가-힣]*)$/);
  if (!match) {
    window.alert("숫자와 단위를 입력하세요. 예: 50 cm");
    return;
  }

  const realLength = Number(match[1]);
  const unit = match[2] || "cm";
  if (!Number.isFinite(realLength) || realLength <= 0 || distancePx <= EPSILON) return;

  player.calibration = {
    pixelsPerUnit: Number((distancePx / realLength).toFixed(6)),
    unit,
    referenceAnnotationId: annotation.id,
    referenceDistancePx: Number(distancePx.toFixed(3)),
    referenceLength: realLength,
  };
  refreshPlayerMeasurements(player);
  updateExports();
  drawAllOverlays();
}

function reverseSelectedAngleSign() {
  const context = state.contextMenu;
  hideContextMenu();
  if (!context) return;

  const player = playerById(context.playerId);
  const annotation = annotationById(context.annotationId);
  if (!player || !annotation || annotation.type !== "angle") return;

  annotation.options = annotation.options ?? {};
  annotation.options.invertAngleSign = !annotation.options.invertAngleSign;
  updateAnnotationMetrics(annotation, player);
  updateExports();
  drawAllOverlays();
}

function trackingTargetForPlayer(player) {
  const selected = annotationById(state.selectedAnnotationId);
  if (selected?.playerId === player.id && ["marker", "trackbox"].includes(selected.type)) return selected;

  const currentTargets = annotationsForFrame(player.id).filter((annotation) => ["marker", "trackbox"].includes(annotation.type));
  if (currentTargets.length) return currentTargets.at(-1);

  return state.annotations
    .filter((annotation) => annotation.playerId === player.id && ["marker", "trackbox"].includes(annotation.type))
    .sort((a, b) => Math.abs(a.analysisTime - state.analysisTime) - Math.abs(b.analysisTime - state.analysisTime))[0] ?? null;
}

function trackingSeed(target, player) {
  if (target.type === "trackbox" && target.points.length >= 2) {
    const rect = rectFromPoints(target.points[0], target.points[1]);
    const videoWidth = player.video?.videoWidth || 1280;
    const videoHeight = player.video?.videoHeight || 720;
    const halfSize = clamp(Math.round(Math.max(rect.width * videoWidth, rect.height * videoHeight) / 2), 8, 24);
    return {
      point: rect.center,
      halfSize,
      roiNorm: {
        width: Math.max(rect.width, halfSize * 2 / videoWidth),
        height: Math.max(rect.height, halfSize * 2 / videoHeight),
      },
      seedType: "trackbox",
    };
  }

  return {
    point: { ...target.points[0] },
    halfSize: 9,
    roiNorm: null,
    seedType: "marker",
  };
}

function seekVideoTo(player, sourceTime) {
  const video = player.video;
  if (!video) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", done);
      resolve();
    };

    if (Math.abs(video.currentTime - sourceTime) <= 0.002 && video.readyState >= 2) {
      requestAnimationFrame(done);
      return;
    }

    video.addEventListener("seeked", done, { once: true });
    video.currentTime = sourceTime;
    window.setTimeout(done, 900);
  });
}

function captureVideoFrame(player) {
  const video = player.video;
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const canvas = player.frameCanvas ?? document.createElement("canvas");
  player.frameCanvas = canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function grayAt(imageData, x, y) {
  const index = (y * imageData.width + x) * 4;
  const data = imageData.data;
  return 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
}

function rgbAt(imageData, x, y) {
  const index = (y * imageData.width + x) * 4;
  const data = imageData.data;
  return {
    r: data[index],
    g: data[index + 1],
    b: data[index + 2],
  };
}

function rgbDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function averageRgb(points) {
  if (!points.length) return { r: 0, g: 0, b: 0 };
  return {
    r: points.reduce((sum, point) => sum + point.r, 0) / points.length,
    g: points.reduce((sum, point) => sum + point.g, 0) / points.length,
    b: points.reduce((sum, point) => sum + point.b, 0) / points.length,
  };
}

function extractColorModel(imageData, point, innerRadius = 10, outerRadius = 28) {
  const centerX = Math.round(point.x * imageData.width);
  const centerY = Math.round(point.y * imageData.height);
  const foreground = [];
  const background = [];

  for (let y = centerY - outerRadius; y <= centerY + outerRadius; y++) {
    if (y < 0 || y >= imageData.height) continue;
    for (let x = centerX - outerRadius; x <= centerX + outerRadius; x++) {
      if (x < 0 || x >= imageData.width) continue;
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance <= innerRadius) foreground.push(rgbAt(imageData, x, y));
      else if (distance >= outerRadius * 0.68 && distance <= outerRadius) background.push(rgbAt(imageData, x, y));
    }
  }

  const fgMean = averageRgb(foreground);
  const bgMean = averageRgb(background);
  return {
    fgMean,
    bgMean,
    separation: rgbDistance(fgMean, bgMean),
    innerRadius,
    outerRadius,
    expectedArea: Math.PI * innerRadius * innerRadius,
  };
}

function objectPixelScore(rgb, model) {
  const foregroundDistance = rgbDistance(rgb, model.fgMean);
  const backgroundDistance = rgbDistance(rgb, model.bgMean);
  const separation = Math.max(model.separation, 12);
  const absoluteScore = clamp(1 - foregroundDistance / Math.max(55, separation * 1.8), 0, 1);
  const relativeScore = clamp((backgroundDistance - foregroundDistance + separation) / (2 * separation), 0, 1);
  return 0.42 * absoluteScore + 0.58 * relativeScore;
}

function trackColorBlob(imageData, model, centerPoint, searchRadius) {
  const centerX = Math.round(centerPoint.x * imageData.width);
  const centerY = Math.round(centerPoint.y * imageData.height);
  const minX = Math.max(0, centerX - searchRadius);
  const maxX = Math.min(imageData.width - 1, centerX + searchRadius);
  const minY = Math.max(0, centerY - searchRadius);
  const maxY = Math.min(imageData.height - 1, centerY + searchRadius);
  const step = searchRadius > 95 ? 2 : 1;
  const sigma = Math.max(searchRadius * 0.62, 1);
  let weightSum = 0;
  let xSum = 0;
  let ySum = 0;
  let accepted = 0;
  let scoreSum = 0;

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > searchRadius) continue;
      const score = objectPixelScore(rgbAt(imageData, x, y), model);
      if (score < 0.48) continue;
      const proximity = Math.exp(-(distance * distance) / (2 * sigma * sigma));
      const weight = score * score * (0.35 + 0.65 * proximity);
      weightSum += weight;
      xSum += x * weight;
      ySum += y * weight;
      accepted += step * step;
      scoreSum += score;
    }
  }

  if (weightSum <= EPSILON || accepted < Math.max(8, model.expectedArea * 0.08)) {
    return { point: centerPoint, confidence: 0, accepted };
  }

  const areaConfidence = clamp(accepted / Math.max(model.expectedArea * 0.32, 1), 0, 1);
  const meanScore = scoreSum / Math.max(accepted / (step * step), 1);
  return {
    point: {
      x: clamp((xSum / weightSum) / imageData.width, 0, 1),
      y: clamp((ySum / weightSum) / imageData.height, 0, 1),
    },
    confidence: Number(clamp(meanScore * (0.45 + 0.55 * areaConfidence), 0, 1).toFixed(4)),
    accepted,
  };
}

function extractTemplate(imageData, point, halfSize) {
  const centerX = Math.round(point.x * imageData.width);
  const centerY = Math.round(point.y * imageData.height);
  const size = halfSize * 2 + 1;
  if (
    centerX - halfSize < 0 ||
    centerY - halfSize < 0 ||
    centerX + halfSize >= imageData.width ||
    centerY + halfSize >= imageData.height
  ) {
    return null;
  }

  const values = new Float32Array(size * size);
  let offset = 0;
  let sum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let y = centerY - halfSize; y <= centerY + halfSize; y++) {
    for (let x = centerX - halfSize; x <= centerX + halfSize; x++) {
      const gray = grayAt(imageData, x, y);
      const rgb = rgbAt(imageData, x, y);
      values[offset++] = gray;
      sum += gray;
      sumR += rgb.r;
      sumG += rgb.g;
      sumB += rgb.b;
    }
  }

  const mean = sum / values.length;
  let variance = 0;
  values.forEach((value) => {
    variance += (value - mean) ** 2;
  });

  return {
    values,
    halfSize,
    size,
    mean,
    variance,
    stdev: Math.sqrt(variance / values.length),
    rgbMean: {
      r: sumR / values.length,
      g: sumG / values.length,
      b: sumB / values.length,
    },
  };
}

function compareTemplateAt(imageData, template, x, y, centerX, centerY, searchRadius) {
  let sum = 0;
  let sumSq = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let offset = 0;

  for (let ty = y - template.halfSize; ty <= y + template.halfSize; ty++) {
    for (let tx = x - template.halfSize; tx <= x + template.halfSize; tx++) {
      const gray = grayAt(imageData, tx, ty);
      const rgb = rgbAt(imageData, tx, ty);
      sum += gray;
      sumSq += gray * gray;
      sumR += rgb.r;
      sumG += rgb.g;
      sumB += rgb.b;
      offset++;
    }
  }

  const n = template.values.length;
  const mean = sum / n;
  const variance = Math.max(sumSq - n * mean * mean, 0);
  let covariance = 0;
  offset = 0;
  for (let ty = y - template.halfSize; ty <= y + template.halfSize; ty++) {
    for (let tx = x - template.halfSize; tx <= x + template.halfSize; tx++) {
      covariance += (grayAt(imageData, tx, ty) - mean) * (template.values[offset++] - template.mean);
    }
  }

  const zncc = template.variance > EPSILON && variance > EPSILON
    ? covariance / Math.sqrt(template.variance * variance)
    : 0;
  const grayScore = clamp((zncc + 1) / 2, 0, 1);
  const rgbMean = {
    r: sumR / n,
    g: sumG / n,
    b: sumB / n,
  };
  const colorDistance = Math.hypot(
    rgbMean.r - template.rgbMean.r,
    rgbMean.g - template.rgbMean.g,
    rgbMean.b - template.rgbMean.b,
  );
  const colorScore = clamp(1 - colorDistance / 441.7, 0, 1);
  const contrastRatio = template.stdev > EPSILON
    ? clamp(Math.sqrt(variance / n) / template.stdev, 0, 2)
    : 1;
  const contrastScore = 1 - Math.min(Math.abs(1 - contrastRatio), 1);
  const distancePenalty = Math.hypot(x - centerX, y - centerY) / Math.max(searchRadius, 1);

  return 0.68 * grayScore + 0.20 * colorScore + 0.08 * contrastScore - 0.04 * distancePenalty;
}

function searchTemplates(imageData, templates, centerPoint, searchRadius, step = 3) {
  const primary = templates[0];
  const centerX = Math.round(centerPoint.x * imageData.width);
  const centerY = Math.round(centerPoint.y * imageData.height);
  const minX = Math.max(primary.halfSize, centerX - searchRadius);
  const maxX = Math.min(imageData.width - primary.halfSize - 1, centerX + searchRadius);
  const minY = Math.max(primary.halfSize, centerY - searchRadius);
  const maxY = Math.min(imageData.height - primary.halfSize - 1, centerY + searchRadius);
  let best = {
    score: Number.NEGATIVE_INFINITY,
    x: clamp(centerX, minX, maxX),
    y: clamp(centerY, minY, maxY),
  };

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      for (const template of templates) {
        const score = compareTemplateAt(imageData, template, x, y, centerX, centerY, searchRadius);
        if (score > best.score) best = { score, x, y };
      }
    }
  }

  const refineRadius = Math.max(step + 2, 4);
  const refineMinX = Math.max(primary.halfSize, best.x - refineRadius);
  const refineMaxX = Math.min(imageData.width - primary.halfSize - 1, best.x + refineRadius);
  const refineMinY = Math.max(primary.halfSize, best.y - refineRadius);
  const refineMaxY = Math.min(imageData.height - primary.halfSize - 1, best.y + refineRadius);
  for (let y = refineMinY; y <= refineMaxY; y++) {
    for (let x = refineMinX; x <= refineMaxX; x++) {
      for (const template of templates) {
        const score = compareTemplateAt(imageData, template, x, y, centerX, centerY, searchRadius);
        if (score > best.score) best = { score, x, y };
      }
    }
  }

  return {
    point: {
      x: clamp(best.x / imageData.width, 0, 1),
      y: clamp(best.y / imageData.height, 0, 1),
    },
    confidence: Number(clamp(best.score, 0, 1).toFixed(4)),
  };
}

function enrichTrackKinematics(track, player) {
  for (let index = 0; index < track.samples.length; index++) {
    const sample = track.samples[index];
    if (index === 0) {
      sample.speedPxPerSec = 0;
      if (player.calibration?.pixelsPerUnit) sample.speedRealPerSec = 0;
      continue;
    }

    const previous = track.samples[index - 1];
    const dt = sample.analysisTime - previous.analysisTime;
    const distancePx = distancePixels(previous, sample, player);
    sample.speedPxPerSec = dt > EPSILON ? Number((distancePx / dt).toFixed(3)) : 0;
    if (player.calibration?.pixelsPerUnit) {
      sample.speedRealPerSec = Number((sample.speedPxPerSec / player.calibration.pixelsPerUnit).toFixed(4));
      sample.unit = `${player.calibration.unit}/s`;
    }
  }
}

function parseTrackingFrameCount(value, remainingFrames) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "all" || trimmed === "end" || trimmed === "끝") return remainingFrames;
  const frameCount = Number(trimmed);
  return Number.isFinite(frameCount) && frameCount > 0 ? Math.min(Math.floor(frameCount), remainingFrames) : 0;
}

function predictNextPoint(samples, fallback) {
  if (samples.length < 2) return fallback;
  const last = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  return {
    x: clamp(last.x + (last.x - previous.x), 0, 1),
    y: clamp(last.y + (last.y - previous.y), 0, 1),
  };
}

function dynamicSearchRadius(samples, imageData, baseRadius) {
  if (samples.length < 2) return baseRadius;
  const last = samples[samples.length - 1];
  const previous = samples[samples.length - 2];
  const dx = (last.x - previous.x) * imageData.width;
  const dy = (last.y - previous.y) * imageData.height;
  const velocityPx = Math.hypot(dx, dy);
  return clamp(Math.round(baseRadius + velocityPx * 2.2), 28, 130);
}

function combineTrackingCandidates(templateMatch, blobMatch, predicted) {
  if (!blobMatch || blobMatch.confidence <= 0.05) {
    return {
      point: templateMatch.point,
      confidence: templateMatch.confidence,
      mode: "template",
      templateConfidence: templateMatch.confidence,
      blobConfidence: blobMatch?.confidence ?? 0,
    };
  }

  const templateWeight = Math.max(templateMatch.confidence - 0.30, 0) * 1.05;
  const blobWeight = Math.max(blobMatch.confidence - 0.22, 0) * 1.45;
  if (blobMatch.confidence >= 0.62 && templateMatch.confidence < 0.55) {
    return {
      point: blobMatch.point,
      confidence: blobMatch.confidence,
      mode: "blob",
      templateConfidence: templateMatch.confidence,
      blobConfidence: blobMatch.confidence,
    };
  }

  if (templateWeight + blobWeight <= EPSILON) {
    return {
      point: predicted,
      confidence: 0,
      mode: "predicted",
      templateConfidence: templateMatch.confidence,
      blobConfidence: blobMatch.confidence,
    };
  }

  return {
    point: {
      x: clamp((templateMatch.point.x * templateWeight + blobMatch.point.x * blobWeight) / (templateWeight + blobWeight), 0, 1),
      y: clamp((templateMatch.point.y * templateWeight + blobMatch.point.y * blobWeight) / (templateWeight + blobWeight), 0, 1),
    },
    confidence: Number(Math.max(templateMatch.confidence, blobMatch.confidence).toFixed(4)),
    mode: blobWeight > templateWeight ? "hybrid-blob" : "hybrid-template",
    templateConfidence: templateMatch.confidence,
    blobConfidence: blobMatch.confidence,
  };
}

function trackDisplacementPx(track, player) {
  if (track.samples.length < 2) return 0;
  return distancePixels(track.samples[0], track.samples.at(-1), player);
}

function smoothTrackSamples(track) {
  if (track.samples.length < 5) return;
  const raw = track.samples.map((sample) => ({
    x: sample.x,
    y: sample.y,
    confidence: sample.confidence ?? 1,
  }));

  for (let index = 0; index < track.samples.length; index++) {
    const start = Math.max(0, index - 2);
    const end = Math.min(track.samples.length - 1, index + 2);
    let sumX = 0;
    let sumY = 0;
    let sumWeight = 0;

    for (let i = start; i <= end; i++) {
      const kernel = 3 - Math.abs(index - i);
      const confidence = Math.max(raw[i].confidence, 0.15);
      const weight = kernel * confidence;
      sumX += raw[i].x * weight;
      sumY += raw[i].y * weight;
      sumWeight += weight;
    }

    track.samples[index].xRaw = Number(raw[index].x.toFixed(6));
    track.samples[index].yRaw = Number(raw[index].y.toFixed(6));
    track.samples[index].x = Number((sumX / sumWeight).toFixed(6));
    track.samples[index].y = Number((sumY / sumWeight).toFixed(6));
  }
}

async function trackSelectedMarkerForward(player = activePlayer()) {
  hideContextMenu();
  if (!player) return;
  const target = trackingTargetForPlayer(player);
  if (!target) {
    window.alert("먼저 마커를 찍거나 트래킹 박스를 드래그한 뒤 T 버튼 또는 우클릭 Track을 사용하세요.");
    return;
  }

  setPlaying(false);
  const fps = player.fps ?? DEFAULT_FPS;
  const startAnalysisTime = target.analysisTime;
  const maxAnalysisTime = analysisDuration();
  const remainingFrames = Math.max(0, Math.floor((maxAnalysisTime - startAnalysisTime) * fps));
  const frameCount = parseTrackingFrameCount(
    window.prompt("앞으로 몇 프레임 추적할까요? 빈칸/all=끝까지", String(Math.min(remainingFrames, 300))) ?? "",
    remainingFrames,
  );
  if (!frameCount) return;

  const seed = trackingSeed(target, player);
  const halfSize = seed.halfSize;
  const baseSearchRadius = 44;
  const updateThreshold = 0.68;
  const recoveryThreshold = 0.46;
  let point = { ...seed.point };

  await seekVideoTo(player, sourceTimeFor(player, startAnalysisTime));
  let imageData = captureVideoFrame(player);
  const initialTemplate = imageData ? extractTemplate(imageData, point, halfSize) : null;
  const colorModel = imageData ? extractColorModel(imageData, point, Math.max(10, halfSize), 32) : null;
  let adaptiveTemplate = initialTemplate;
  if (!initialTemplate || !colorModel) {
    window.alert("마커가 영상 가장자리와 너무 가깝습니다. 조금 안쪽에 마커를 놓고 다시 시도하세요.");
    return;
  }

  const track = {
    id: uid(),
    playerId: player.id,
    sourceAnnotationId: target.id,
    label: `track-${state.tracks.length + 1}`,
    type: "marker",
    seedType: seed.seedType,
    roiNorm: seed.roiNorm,
    algorithm: "hybrid-zncc-color-blob-predictive-v2",
    analysisStart: Number(startAnalysisTime.toFixed(6)),
    fps,
    templateSize: halfSize * 2 + 1,
    baseSearchRadius,
    updateThreshold,
    recoveryThreshold,
    colorModel: {
      fgMean: colorModel.fgMean,
      bgMean: colorModel.bgMean,
      separation: Number(colorModel.separation.toFixed(3)),
    },
    samples: [],
  };

  els.playPause.textContent = "…";
  for (let frame = 0; frame <= frameCount; frame++) {
    const analysisTime = startAnalysisTime + frame / fps;
    if (analysisTime > maxAnalysisTime) break;
    if (frame % 10 === 0) {
      els.timeReadout.textContent = `tracking ${frame}/${frameCount}`;
    }
    await seekVideoTo(player, sourceTimeFor(player, analysisTime));
    imageData = captureVideoFrame(player);
    if (!imageData) break;

    if (frame > 0) {
      const predicted = predictNextPoint(track.samples, point);
      const searchRadius = dynamicSearchRadius(track.samples, imageData, baseSearchRadius);
      let match = searchTemplates(imageData, [adaptiveTemplate, initialTemplate], predicted, searchRadius, searchRadius > 80 ? 4 : 3);
      let blobMatch = trackColorBlob(imageData, colorModel, predicted, searchRadius);
      let recovered = false;

      if (match.confidence < recoveryThreshold) {
        const recovery = searchTemplates(imageData, [initialTemplate], point, Math.min(searchRadius * 2, 150), 5);
        if (recovery.confidence > match.confidence) {
          match = recovery;
          recovered = true;
        }
        const blobRecovery = trackColorBlob(imageData, colorModel, point, Math.min(searchRadius * 2, 150));
        if (blobRecovery.confidence > blobMatch.confidence) {
          blobMatch = blobRecovery;
          recovered = true;
        }
      }

      const combined = combineTrackingCandidates(match, blobMatch, predicted);
      point = combined.point;
      track.samples.push({
        analysisTime: Number(analysisTime.toFixed(6)),
        sourceTime: Number(sourceTimeFor(player, analysisTime).toFixed(6)),
        x: Number(point.x.toFixed(6)),
        y: Number(point.y.toFixed(6)),
        confidence: combined.confidence,
        templateConfidence: Number(combined.templateConfidence.toFixed(4)),
        blobConfidence: Number(combined.blobConfidence.toFixed(4)),
        predictedX: Number(predicted.x.toFixed(6)),
        predictedY: Number(predicted.y.toFixed(6)),
        searchRadius,
        mode: combined.mode,
        recovered,
      });
    } else {
      track.samples.push({
        analysisTime: Number(analysisTime.toFixed(6)),
        sourceTime: Number(sourceTimeFor(player, analysisTime).toFixed(6)),
        x: Number(point.x.toFixed(6)),
        y: Number(point.y.toFixed(6)),
        confidence: 1,
        templateConfidence: 1,
        blobConfidence: 1,
        predictedX: Number(point.x.toFixed(6)),
        predictedY: Number(point.y.toFixed(6)),
        searchRadius: baseSearchRadius,
        mode: "seed",
        recovered: false,
      });
    }

    const nextTemplate = extractTemplate(imageData, point, halfSize);
    const lastSample = track.samples[track.samples.length - 1];
    if (nextTemplate && lastSample.confidence >= updateThreshold) {
      adaptiveTemplate = nextTemplate;
    }
  }

  smoothTrackSamples(track);
  enrichTrackKinematics(track, player);
  track.displacementPx = Number(trackDisplacementPx(track, player).toFixed(3));
  if (player.calibration?.pixelsPerUnit) {
    track.displacementReal = Number((track.displacementPx / player.calibration.pixelsPerUnit).toFixed(4));
    track.unit = player.calibration.unit;
  }
  state.tracks.push(track);
  state.selectedAnnotationId = target.id;
  updateExports();
  seekAll(startAnalysisTime);
  els.playPause.textContent = "▶";
  window.alert(`${track.samples.length}개 프레임을 추적했습니다. 총 이동: ${distanceLabel(track.displacementPx, player)}, 평균 confidence: ${(
    track.samples.reduce((sum, sample) => sum + (sample.confidence ?? 0), 0) / Math.max(track.samples.length, 1)
  ).toFixed(3)}`);
}

function playerCard(player) {
  const sourceTime = sourceTimeFor(player);
  return `
    <section class="player-card ${state.activePlayerId === player.id ? "active" : ""}" data-player-id="${player.id}">
      <div class="player-head">
        <div>
          <strong>${player.name}</strong>
          <span>${secondsLabel(sourceTime)} / ${secondsLabel(player.duration)}</span>
        </div>
        <button class="ghost small" data-action="activate">활성</button>
      </div>
      <div class="video-wrap">
        <video playsinline muted preload="metadata" src="${player.objectUrl}"></video>
        <canvas class="overlay"></canvas>
        <div class="player-tools" aria-label="측정 도구">
          <button type="button" data-tool="select" title="선택">S</button>
          <button type="button" data-tool="marker" title="마커">+</button>
          <button type="button" data-tool="line" title="거리">/</button>
          <button type="button" data-tool="angle" title="3마커 각도">A</button>
          <button type="button" data-tool="trackbox" title="트래킹 박스">□</button>
          <button type="button" data-action="track-marker" title="선택 마커/박스 트래킹">T</button>
        </div>
      </div>
      <div class="trim-grid">
        <label>In <input data-field="sourceIn" type="number" min="0" step="0.001" value="${player.sourceIn.toFixed(3)}"></label>
        <label>Out <input data-field="sourceOut" type="number" min="0" step="0.001" value="${player.sourceOut.toFixed(3)}"></label>
        <label>Offset <input data-field="syncOffset" type="number" step="0.001" value="${player.syncOffset.toFixed(3)}"></label>
        <label>FPS <input data-field="fps" type="number" min="1" step="0.001" value="${player.fps}"></label>
      </div>
    </section>
  `;
}

function renderPlayers() {
  els.emptyState.hidden = state.players.length > 0;
  els.playerGrid.innerHTML = state.players.map(playerCard).join("");
  els.playerGrid.className = `player-grid count-${Math.min(state.players.length, 4)}`;

  state.players.forEach((player) => {
    const card = els.playerGrid.querySelector(`[data-player-id="${player.id}"]`);
    const video = card.querySelector("video");
    const canvas = card.querySelector("canvas");
    player.video = video;
    player.canvas = canvas;

    card.querySelector('[data-action="activate"]').addEventListener("click", () => setActivePlayer(player.id));
    card.querySelector('[data-action="track-marker"]').addEventListener("click", (event) => {
      event.stopPropagation();
      setActivePlayer(player.id);
      trackSelectedMarkerForward(player);
    });
    card.addEventListener("pointerdown", () => setActivePlayer(player.id));
    canvas.addEventListener("pointerdown", (event) => handleCanvasPointerDown(event, player));
    canvas.addEventListener("pointermove", (event) => handleCanvasPointerMove(event, player));
    canvas.addEventListener("pointerup", (event) => finishCanvasInteraction(event, player));
    canvas.addEventListener("pointercancel", (event) => finishCanvasInteraction(event, player));
    canvas.addEventListener("contextmenu", (event) => showContextMenu(event, player));

    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("change", () => {
        const field = input.dataset.field;
        const numeric = Number(input.value);
        if (!Number.isFinite(numeric)) return;
        if (field === "sourceIn") {
          player.sourceIn = clamp(numeric, 0, player.duration);
          player.sourceOut = Math.max(player.sourceOut, player.sourceIn);
        } else if (field === "sourceOut") {
          player.sourceOut = clamp(numeric, player.sourceIn, player.duration);
        } else if (field === "syncOffset") {
          player.syncOffset = numeric;
        } else if (field === "fps") {
          player.fps = Math.max(1, numeric);
        }
        seekAll(state.analysisTime);
        updateTimeline();
        updateExports();
      });
    });

    resizeCanvas(player);
    video.currentTime = sourceTimeFor(player);
  });

  updateTimeline();
  updateActivePlayerUI();
  updateToolUI();
  drawAllOverlays();
}

function resizeCanvas(player) {
  if (!player.canvas) return;
  const rect = player.canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  player.canvas.width = Math.max(1, Math.floor(rect.width * scale));
  player.canvas.height = Math.max(1, Math.floor(rect.height * scale));
}

function handleCanvasPointerDown(event, player) {
  event.stopPropagation();
  event.preventDefault();
  setActivePlayer(player.id);
  const point = normalizedPoint(event, player);
  player.canvas.setPointerCapture?.(event.pointerId);
  const hit = hitTestAnnotation(player, point);

  if (hit && (state.selectedTool === "select" || hit.annotation.type === state.selectedTool || hit.mode === "point")) {
    state.selectedAnnotationId = hit.annotation.id;
    state.interaction = {
      type: hit.mode === "point" ? "drag-point" : "drag-body",
      playerId: player.id,
      annotationId: hit.annotation.id,
      pointIndex: hit.pointIndex,
      lastPoint: point,
      pointerId: event.pointerId,
    };
    drawAllOverlays();
    return;
  }

  if (state.selectedTool === "select") {
    state.selectedAnnotationId = null;
    drawAllOverlays();
    return;
  }

  if (state.selectedTool === "line") {
    const annotation = createAnnotation(player, "line", [point, point]);
    state.selectedAnnotationId = annotation.id;
    state.interaction = {
      type: "drag-point",
      playerId: player.id,
      annotationId: annotation.id,
      pointIndex: 1,
      pointerId: event.pointerId,
    };
    drawAllOverlays();
    return;
  }

  if (state.selectedTool === "angle") {
    const annotation = createAnnotation(player, "angle", createDefaultAnglePoints(point));
    state.selectedAnnotationId = annotation.id;
    state.interaction = {
      type: "drag-body",
      playerId: player.id,
      annotationId: annotation.id,
      lastPoint: point,
      pointerId: event.pointerId,
    };
    drawAllOverlays();
    return;
  }

  if (state.selectedTool === "marker") {
    const annotation = createAnnotation(player, "marker", [point]);
    state.selectedAnnotationId = annotation.id;
    state.interaction = {
      type: "drag-point",
      playerId: player.id,
      annotationId: annotation.id,
      pointIndex: 0,
      pointerId: event.pointerId,
    };
    drawAllOverlays();
    return;
  }

  if (state.selectedTool === "trackbox") {
    const annotation = createAnnotation(player, "trackbox", [point, point]);
    state.selectedAnnotationId = annotation.id;
    state.interaction = {
      type: "drag-point",
      playerId: player.id,
      annotationId: annotation.id,
      pointIndex: 1,
      pointerId: event.pointerId,
    };
    drawAllOverlays();
    return;
  }
}

function handleCanvasPointerMove(event, player) {
  if (!state.interaction || state.interaction.playerId !== player.id) return;
  if (state.interaction.pointerId !== event.pointerId) return;
  event.preventDefault();
  const annotation = annotationById(state.interaction.annotationId);
  if (!annotation) return;
  const point = normalizedPoint(event, player);

  if (state.interaction.type === "drag-point") {
    annotation.points[state.interaction.pointIndex] = point;
  }

  if (state.interaction.type === "drag-body") {
    const lastPoint = state.interaction.lastPoint ?? point;
    moveAnnotation(annotation, {
      x: point.x - lastPoint.x,
      y: point.y - lastPoint.y,
    });
    state.interaction.lastPoint = point;
  }

  updateAnnotationMetrics(annotation, player);
  updateExports();
  drawAllOverlays();
}

function finishCanvasInteraction(event, player) {
  if (!state.interaction || state.interaction.playerId !== player.id) return;
  if (state.interaction.pointerId !== event.pointerId) return;
  const annotation = annotationById(state.interaction.annotationId);
  if (annotation) updateAnnotationMetrics(annotation, player);
  state.interaction = null;
  player.canvas.releasePointerCapture?.(event.pointerId);
  updateExports();
  drawAllOverlays();
}

async function addFiles(files) {
  const newPlayers = await Promise.all(
    [...files].map(
      (file) =>
        new Promise((resolve) => {
          const objectUrl = URL.createObjectURL(file);
          const probe = document.createElement("video");
          probe.preload = "metadata";
          probe.src = objectUrl;
          probe.onloadedmetadata = () => {
            const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
          resolve({
            id: uid(),
            videoAssetId: uid(),
              name: file.name,
              fileName: file.name,
              objectUrl,
              duration,
              sourceIn: 0,
              sourceOut: duration,
              syncOffset: 0,
              fps: DEFAULT_FPS,
              calibration: {
                pixelsPerUnit: null,
                unit: "cm",
              },
            });
          };
        }),
    ),
  );

  state.players.push(...newPlayers);
  if (!state.activePlayerId && state.players.length) state.activePlayerId = state.players[0].id;
  renderPlayers();
  updateExports();
}

function seekAll(analysisTime) {
  state.analysisTime = clamp(analysisTime, 0, analysisDuration());
  state.players.forEach((player) => syncVideoElement(player, false));
  updateTimeline();
  drawAllOverlays();
}

function setPlaying(playing) {
  if (!state.players.length) return;
  state.playing = playing;
  state.lastTick = performance.now();
  els.playPause.textContent = playing ? "⏸" : "▶";
  if (playing) {
    state.players.forEach((player) => syncVideoElement(player, true));
    requestAnimationFrame(tick);
  } else {
    state.players.forEach((player) => syncVideoElement(player, false));
  }
}

function tick(now) {
  if (!state.playing) return;
  const delta = (now - state.lastTick) / 1000;
  state.lastTick = now;
  const next = state.analysisTime + delta;
  if (next >= analysisDuration()) {
    seekAll(analysisDuration());
    setPlaying(false);
    return;
  }
  state.analysisTime = next;
  state.players.forEach((player) => syncVideoElement(player, true));
  updateTimeline();
  drawAllOverlays();
  requestAnimationFrame(tick);
}

function stepFrame(direction) {
  const player = activePlayer();
  const fps = player?.fps ?? DEFAULT_FPS;
  setPlaying(false);
  seekAll(state.analysisTime + direction / fps);
}

function updateTimeline() {
  const duration = analysisDuration();
  els.timeline.max = duration || 0;
  els.timeline.value = state.analysisTime;
  els.timeReadout.textContent = `${secondsLabel(state.analysisTime)} / ${secondsLabel(duration)}`;
}

function drawAllOverlays() {
  state.players.forEach(drawOverlay);
}

function drawOverlay(player) {
  if (!player.canvas) return;
  resizeCanvas(player);
  const ctx = player.canvas.getContext("2d");
  ctx.clearRect(0, 0, player.canvas.width, player.canvas.height);
  ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
  ctx.font = `${12 * (window.devicePixelRatio || 1)}px ui-monospace, SFMono-Regular, Consolas, monospace`;

  drawTracks(ctx, player);
  annotationsForFrame(player.id).forEach((annotation) => drawAnnotation(ctx, player, annotation));

  if (state.currentDraft?.playerId === player.id) {
    drawAnnotation(ctx, player, {
      type: state.currentDraft.type,
      points: state.currentDraft.points,
      label: "draft",
    }, true);
  }
}

function drawTracks(ctx, player) {
  const tracks = state.tracks.filter((track) => track.playerId === player.id);

  tracks.forEach((track) => {
    const trace = track.samples.filter((sample) => sample.analysisTime <= state.analysisTime).slice(-80);
    if (trace.length >= 2) {
      ctx.strokeStyle = "rgba(248, 212, 92, 0.78)";
      ctx.beginPath();
      trace.forEach((sample, index) => {
        const point = denormalize({ x: sample.x, y: sample.y }, player);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }

    const current = sampleAtTrackTime(track, state.analysisTime);
    if (current) {
      const point = { x: current.x, y: current.y };
      drawPoint(ctx, point, player, "#f8d45c", true);
      if (track.roiNorm) drawTrackBox(ctx, point, track.roiNorm, player);
      drawLabel(ctx, `${track.label ?? "track"} ${Math.round((current.confidence ?? 0) * 100)}%`, point, player);
    }
  });
}

function sampleAtTrackTime(track, analysisTime) {
  if (!track.samples.length) return null;
  if (analysisTime < track.samples[0].analysisTime || analysisTime > track.samples.at(-1).analysisTime) return null;

  for (let index = 0; index < track.samples.length - 1; index++) {
    const current = track.samples[index];
    const next = track.samples[index + 1];
    if (analysisTime >= current.analysisTime && analysisTime <= next.analysisTime) {
      const span = next.analysisTime - current.analysisTime;
      const t = span > EPSILON ? (analysisTime - current.analysisTime) / span : 0;
      return {
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
        confidence: current.confidence + ((next.confidence ?? current.confidence) - current.confidence) * t,
      };
    }
  }

  return track.samples.at(-1);
}

function drawPoint(ctx, point, player, color = "#f8d45c", selected = false) {
  const p = denormalize(point, player);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#111";
  ctx.lineWidth = selected ? 3 * (window.devicePixelRatio || 1) : 2 * (window.devicePixelRatio || 1);
  ctx.beginPath();
  ctx.arc(p.x, p.y, (selected ? 7 : 6) * (window.devicePixelRatio || 1), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawLine(ctx, a, b, player, color = "#4ee0b5") {
  const pa = denormalize(a, player);
  const pb = denormalize(b, player);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
  ctx.stroke();
}

function drawRect(ctx, rect, player, color = "#4ee0b5") {
  const topLeft = denormalize({ x: rect.x, y: rect.y }, player);
  const bottomRight = denormalize({ x: rect.x + rect.width, y: rect.y + rect.height }, player);
  ctx.strokeStyle = color;
  ctx.setLineDash([6 * (window.devicePixelRatio || 1), 4 * (window.devicePixelRatio || 1)]);
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.setLineDash([]);
}

function drawTrackBox(ctx, center, roiNorm, player) {
  drawRect(ctx, {
    x: clamp(center.x - roiNorm.width / 2, 0, 1),
    y: clamp(center.y - roiNorm.height / 2, 0, 1),
    width: roiNorm.width,
    height: roiNorm.height,
  }, player, "#f8d45c");
}

function drawLabel(ctx, text, point, player) {
  const p = denormalize(point, player);
  ctx.fillStyle = "rgba(14, 20, 18, 0.82)";
  ctx.fillRect(p.x + 8, p.y - 22, ctx.measureText(text).width + 12, 22);
  ctx.fillStyle = "#f7f3e8";
  ctx.fillText(text, p.x + 14, p.y - 7);
}

function drawAngleArc(ctx, player, annotation, color) {
  const [a, b, c] = annotation.points;
  const pa = denormalize(a, player);
  const pb = denormalize(b, player);
  const pc = denormalize(c, player);
  const radius = Math.max(
    22 * (window.devicePixelRatio || 1),
    Math.min(
      56 * (window.devicePixelRatio || 1),
      canvasDistance(a, b, player) * 0.32,
      canvasDistance(c, b, player) * 0.32,
    ),
  );
  const start = Math.atan2(pa.y - pb.y, pa.x - pb.x);
  const end = Math.atan2(pc.y - pb.y, pc.x - pb.x);
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(pb.x, pb.y, radius, start, start + delta, delta < 0);
  ctx.stroke();

  const mid = start + delta / 2;
  const labelPoint = {
    x: (pb.x + Math.cos(mid) * (radius + 18 * (window.devicePixelRatio || 1)) - videoContentRect(player, true).x) / videoContentRect(player, true).width,
    y: (pb.y + Math.sin(mid) * (radius + 18 * (window.devicePixelRatio || 1)) - videoContentRect(player, true).y) / videoContentRect(player, true).height,
  };
  drawLabel(ctx, formatAngle(angleForAnnotation(annotation, player)), labelPoint, player);
}

function drawAnnotation(ctx, player, annotation, isDraft = false) {
  const selected = annotation.id === state.selectedAnnotationId;
  const color = isDraft ? "#f8d45c" : selected ? "#f8d45c" : "#4ee0b5";
  annotation.points.forEach((point) => drawPoint(ctx, point, player, color, selected));

  if (annotation.type === "line" && annotation.points.length >= 2) {
    drawLine(ctx, annotation.points[0], annotation.points[1], player, color);
    drawLabel(ctx, distanceLabel(distancePixels(annotation.points[0], annotation.points[1], player), player), midpoint(annotation.points[0], annotation.points[1]), player);
  }

  if (annotation.type === "angle") {
    if (annotation.points.length >= 2) drawLine(ctx, annotation.points[0], annotation.points[1], player, color);
    if (annotation.points.length >= 3) {
      drawLine(ctx, annotation.points[1], annotation.points[2], player, color);
      drawAngleArc(ctx, player, annotation, color);
    }
  }

  if (annotation.type === "trackbox" && annotation.points.length >= 2) {
    const rect = rectFromPoints(annotation.points[0], annotation.points[1]);
    drawRect(ctx, rect, player, color);
    drawLabel(ctx, "tracking ROI", rect.center, player);
  }

  if (annotation.type === "marker" && annotation.points.length) {
    drawLabel(ctx, annotation.label, annotation.points[0], player);
  }
}

function projectSnapshot() {
  return {
    projectId: state.projectId,
    analysisTime: state.analysisTime,
    players: state.players.map((player) => ({
      id: player.id,
      videoAssetId: player.videoAssetId,
      fileName: player.fileName,
      duration: player.duration,
      sourceIn: player.sourceIn,
      sourceOut: player.sourceOut,
      syncOffset: player.syncOffset,
      fps: player.fps,
      calibration: player.calibration,
    })),
    annotations: state.annotations,
    tracks: state.tracks,
  };
}

function updateExports() {
  els.projectJson.value = JSON.stringify(projectSnapshot(), null, 2);
}

function csvRows() {
  const rows = [["id", "playerId", "type", "analysisTime", "sourceTime", "metricName", "metricValue", "pointIndex", "xNorm", "yNorm"]];
  state.annotations.forEach((annotation) => {
    const metricEntries = Object.entries(annotation.metrics ?? {});
    const metricName = metricEntries.map(([key]) => key).join("|");
    const metricValue = metricEntries.map(([, value]) => value).join("|");
    annotation.points.forEach((point, index) => {
      rows.push([
        annotation.id,
        annotation.playerId,
        annotation.type,
        annotation.analysisTime,
        annotation.sourceTime,
        metricName,
        metricValue,
        index,
        point.x,
        point.y,
      ]);
    });
  });
  state.tracks.forEach((track) => {
    track.samples.forEach((sample, index) => {
      const metricPairs = [
        ["confidence", sample.confidence],
        ["templateConfidence", sample.templateConfidence],
        ["blobConfidence", sample.blobConfidence],
        ["speedPxPerSec", sample.speedPxPerSec],
        ["searchRadius", sample.searchRadius],
        ["recovered", sample.recovered],
        ["mode", sample.mode],
      ];
      if (sample.speedRealPerSec !== undefined) metricPairs.push(["speedRealPerSec", sample.speedRealPerSec]);
      if (sample.unit) metricPairs.push(["unit", sample.unit]);
      if (sample.xRaw !== undefined) metricPairs.push(["xRaw", sample.xRaw]);
      if (sample.yRaw !== undefined) metricPairs.push(["yRaw", sample.yRaw]);
      rows.push([
        track.id,
        track.playerId,
        "track-marker",
        sample.analysisTime,
        sample.sourceTime,
        metricPairs.map(([key]) => key).join("|"),
        metricPairs.map(([, value]) => value).join("|"),
        index,
        sample.x,
        sample.y,
      ]);
    });
  });
  return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
}

function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

els.fileInput.addEventListener("change", (event) => addFiles(event.target.files));
els.playPause.addEventListener("click", () => setPlaying(!state.playing));
els.stepBack.addEventListener("click", () => stepFrame(-1));
els.stepForward.addEventListener("click", () => stepFrame(1));
els.timeline.addEventListener("input", () => {
  setPlaying(false);
  seekAll(Number(els.timeline.value));
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tool]");
  if (!button) return;
  event.preventDefault();
  const card = button.closest(".player-card");
  if (card) setActivePlayer(card.dataset.playerId);
  setTool(button.dataset.tool);
});
els.calibrateAction.addEventListener("click", calibrateSelectedLine);
els.reverseAngleAction.addEventListener("click", reverseSelectedAngleSign);
els.trackMarkerAction.addEventListener("click", () => {
  const context = state.contextMenu;
  const player = context ? playerById(context.playerId) : activePlayer();
  trackSelectedMarkerForward(player);
});
document.addEventListener("pointerdown", (event) => {
  if (!els.contextMenu.hidden && !event.target.closest("#contextMenu")) hideContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideContextMenu();
});
els.exportCsv.addEventListener("click", () => downloadText("analysis_annotations.csv", csvRows(), "text/csv"));
els.exportProject.addEventListener("click", () => downloadText("kinematic_project.json", JSON.stringify(projectSnapshot(), null, 2), "application/json"));
window.addEventListener("resize", drawAllOverlays);

setTool("select");
updateExports();
