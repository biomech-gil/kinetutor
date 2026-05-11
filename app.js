const state = {
  projectId: uid(),
  analysisTime: 0,
  playing: false,
  activePlayerId: null,
  selectedTool: "select",
  currentDraft: null,
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
  toolButtons: document.querySelectorAll("[data-tool]"),
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
  els.toolButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  drawAllOverlays();
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

function angleDegrees(a, b, c, player) {
  const pa = sourcePixelPoint(a, player);
  const pb = sourcePixelPoint(b, player);
  const pc = sourcePixelPoint(c, player);
  const ab = { x: pa.x - pb.x, y: pa.y - pb.y };
  const cb = { x: pc.x - pb.x, y: pc.y - pb.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (mag < EPSILON) return 0;
  return (Math.acos(clamp(dot / mag, -1, 1)) * 180) / Math.PI;
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
    metrics: measurementMetrics(player, type, points),
    label: `${type}-${state.annotations.length + 1}`,
  };
  state.annotations.push(annotation);
  updateExports();
  drawAllOverlays();
}

function measurementMetrics(player, type, points) {
  if (type === "line" && points.length >= 2) {
    return {
      distancePx: Number(distancePixels(points[0], points[1], player).toFixed(3)),
    };
  }

  if (type === "angle" && points.length >= 3) {
    return {
      angleDeg: Number(angleDegrees(points[0], points[1], points[2], player).toFixed(3)),
    };
  }

  return {};
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
    card.addEventListener("pointerdown", () => setActivePlayer(player.id));
    canvas.addEventListener("pointerdown", (event) => handleCanvasClick(event, player));

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
  drawAllOverlays();
}

function resizeCanvas(player) {
  if (!player.canvas) return;
  const rect = player.canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  player.canvas.width = Math.max(1, Math.floor(rect.width * scale));
  player.canvas.height = Math.max(1, Math.floor(rect.height * scale));
}

function handleCanvasClick(event, player) {
  event.stopPropagation();
  if (state.selectedTool === "select") return;
  setActivePlayer(player.id);
  const point = normalizedPoint(event, player);
  const requiredPoints = state.selectedTool === "angle" ? 3 : state.selectedTool === "marker" ? 1 : 2;

  if (!state.currentDraft || state.currentDraft.playerId !== player.id || state.currentDraft.type !== state.selectedTool) {
    state.currentDraft = {
      playerId: player.id,
      type: state.selectedTool,
      points: [],
    };
  }

  state.currentDraft.points.push(point);

  if (state.currentDraft.points.length >= requiredPoints) {
    createAnnotation(player, state.currentDraft.type, state.currentDraft.points);
    state.currentDraft = null;
  } else {
    drawAllOverlays();
  }
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
                unit: "px",
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
  els.playPause.textContent = playing ? "정지" : "재생";
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

  annotationsForFrame(player.id).forEach((annotation) => drawAnnotation(ctx, player, annotation));

  if (state.currentDraft?.playerId === player.id) {
    drawAnnotation(ctx, player, {
      type: state.currentDraft.type,
      points: state.currentDraft.points,
      label: "draft",
    }, true);
  }
}

function drawPoint(ctx, point, player, color = "#f8d45c") {
  const p = denormalize(point, player);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#111";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 6 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
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

function drawLabel(ctx, text, point, player) {
  const p = denormalize(point, player);
  ctx.fillStyle = "rgba(14, 20, 18, 0.82)";
  ctx.fillRect(p.x + 8, p.y - 22, ctx.measureText(text).width + 12, 22);
  ctx.fillStyle = "#f7f3e8";
  ctx.fillText(text, p.x + 14, p.y - 7);
}

function drawAnnotation(ctx, player, annotation, isDraft = false) {
  const color = isDraft ? "#f8d45c" : "#4ee0b5";
  annotation.points.forEach((point) => drawPoint(ctx, point, player, color));

  if (annotation.type === "line" && annotation.points.length >= 2) {
    drawLine(ctx, annotation.points[0], annotation.points[1], player, color);
    drawLabel(ctx, `${Math.round(distancePixels(annotation.points[0], annotation.points[1], player))} px`, annotation.points[1], player);
  }

  if (annotation.type === "angle") {
    if (annotation.points.length >= 2) drawLine(ctx, annotation.points[0], annotation.points[1], player, color);
    if (annotation.points.length >= 3) {
      drawLine(ctx, annotation.points[1], annotation.points[2], player, color);
      drawLabel(ctx, `${angleDegrees(annotation.points[0], annotation.points[1], annotation.points[2], player).toFixed(1)}°`, annotation.points[1], player);
    }
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
  const rows = [["annotationId", "playerId", "type", "analysisTime", "sourceTime", "metricName", "metricValue", "pointIndex", "xNorm", "yNorm"]];
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
els.toolButtons.forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
els.exportCsv.addEventListener("click", () => downloadText("analysis_annotations.csv", csvRows(), "text/csv"));
els.exportProject.addEventListener("click", () => downloadText("kinematic_project.json", JSON.stringify(projectSnapshot(), null, 2), "application/json"));
window.addEventListener("resize", drawAllOverlays);

setTool("select");
updateExports();
