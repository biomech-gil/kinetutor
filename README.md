# KineTutor

KineTutor is a browser-based educational kinematics tool for learning video motion analysis. It started as a pragmatic web-native alternative to a subset of Kinovea-style workflows: synchronized video playback, manual angles/distances, calibration, and marker tracking.

The project is intentionally a dependency-free static web app for now. Open `index.html` or serve the folder with a tiny static server. This keeps iteration fast while the motion-analysis data model and interaction patterns are still being shaped.

## Background And Goal

The target user is a biomechanics educator/researcher who needs a lightweight tool for teaching 2D video kinematics:

- Load one or more videos.
- Synchronize split-view playback with per-video trim and offset.
- Draw markers, distances, angles, and tracking ROIs directly on video.
- Calibrate a drawn segment to a real-world length such as `50 cm`.
- Track a thrown object or marker through frames.
- Export the project and measurements for later analysis.

This is not a Kinovea fork. It is a new web implementation that borrows useful interaction ideas while keeping the architecture ready for future AI pose estimation, external pose-result import, and backend video preprocessing.

## Run Locally

From the repository root:

```powershell
python -m http.server 5187
```

Then open:

```text
http://127.0.0.1:5187
```

If the app looks stale after code changes, force reload the browser with `Ctrl + F5`.

## Current Workflow

1. Upload one or more videos.
2. Use each player’s `In`, `Out`, `Offset`, and `FPS` controls to align videos on the shared analysis timeline.
3. Use the in-video tool buttons:
   - `S`: select/edit
   - `+`: marker
   - `/`: distance line
   - `A`: 3-point angle
   - `□`: tracking ROI box
   - `T`: track the selected marker/ROI forward
4. Drag the timeline or use `‹ 1f`, `▶/⏸`, `1f ›` to inspect frame-by-frame motion.
5. Export JSON or CSV from the left panel.

## Implemented Features

- Multi-video upload and split-view player grid.
- Shared `analysisTime` timeline across all videos.
- Per-player non-destructive trim/sync model using `sourceIn`, `sourceOut`, and `syncOffset`.
- Frame stepping based on the active player’s `fps`.
- Manual marker, distance, angle, and tracking ROI annotations.
- Draggable annotation editing:
  - Drag marker to move it.
  - Drag distance/angle handles to edit geometry.
  - Drag angle body or ROI box body to move the whole object.
  - Marker-linked ROI boxes move with the marker.
- Signed 3-point angle calculation, with right-click `Reverse angle sign`.
- Distance calibration:
  - Draw a distance line.
  - Right-click it.
  - Choose `Calibrate length...`.
  - Enter a real-world length such as `50 cm`.
  - Subsequent distances use that player’s `pixelsPerUnit`.
- Right-click context menu for object-specific actions:
  - Calibrate line length.
  - Reverse angle sign.
  - Attach tracking box to marker.
  - Track forward.
  - Delete individual marker/line/angle/ROI/track.
- Project JSON export.
- Measurement CSV export, including annotations and track samples.

## Tracking Workflow

The recommended tracking workflow is marker plus ROI:

1. Use `+` to place a marker at the object center.
2. Right-click that marker.
3. Choose `Set tracking box...`.
4. Drag a box around the whole object, with a small margin.
5. Select the marker and press `T`, or right-click and choose `Track forward...`.
6. Enter a frame count or `all`.
7. Press play. The tracked point/box should follow frame-by-frame according to the current timeline position.

The standalone `□` tracking box also works, but for objects like a shot put ball, marker plus ROI is the preferred workflow because it combines an explicit center point with the visual model inside the ROI.

## Tracking Algorithm

Current algorithm: `hybrid-zncc-color-blob-predictive-v2`.

The tracker combines several browser-side signals:

- Initial template anchor: the first template is kept to reduce drift.
- Adaptive template: updated only on high-confidence frames.
- Motion prediction: next search center uses previous velocity.
- Template matching: normalized grayscale correlation with color similarity, contrast stability, and distance penalty.
- Color blob model: foreground/background color model from the linked ROI; useful for round objects such as shot puts.
- Recovery search: if confidence drops, the tracker expands the search around the previous point.
- Smoothing: confidence-weighted local smoothing before velocity calculation.

Track samples are stored in `tracks[].samples` with:

- `analysisTime`
- `sourceTime`
- normalized `x`, `y`
- `confidence`
- `templateConfidence`
- `blobConfidence`
- `mode`
- `speedPxPerSec`
- calibrated `speedRealPerSec` when calibration exists

## Data Model Notes

The core timing equation is:

```text
sourceTime = analysisTime + sourceIn + syncOffset
```

All annotations and tracks are stored against `analysisTime`, while each player computes its own video `sourceTime`. This is essential for multi-view synchronization, future AI pose import, and consistent CSV export.

Coordinates are normalized to the actual video frame, not the canvas box. Letterboxing is excluded from the coordinate system.

Important top-level state:

- `players`: uploaded video instances and per-player settings.
- `annotations`: frame annotations such as marker, line, angle, and tracking ROI.
- `tracks`: time-series tracking results.
- `calibration`: per-player pixel-to-real-unit conversion.

## Known Limitations

- Videos are played directly by the browser. There is no backend FFmpeg proxy yet.
- Variable-frame-rate videos may not produce perfectly stable frame stepping.
- Browser template tracking is useful for education/prototyping but not yet a validated biomechanical measurement engine.
- Tracking can still fail when the object has low contrast, occlusion, motion blur, or a background with similar colors.
- There is no project import yet, only export.
- No automated tests are present yet.
- The UI is still a prototype and should be hardened before classroom use.

## Next Work For A Follow-Up AI

Highest-priority engineering tasks:

- Add project JSON import so exported work can be reopened.
- Add track editing: delete samples, correct a bad frame, interpolate corrected sections.
- Add a visible tracking status/progress overlay instead of `alert()`.
- Improve ROI controls: resize handles, locked aspect ratio, and clearer selected state.
- Add per-track settings: search radius, ROI size, confidence threshold, smoothing on/off.
- Add validation samples and simple regression tests for angle, calibration, and timeline mapping.
- Add backend preprocessing option to convert uploads to constant-frame-rate proxy MP4.
- Add AI pose import using the same `analysisTime` track structure.

Useful implementation locations:

- `app.js`: all current state, rendering, annotation interaction, tracking, export.
- `index.html`: static UI shell and context menu.
- `styles.css`: layout, video player stage, tools, transport controls.

## Repository

GitHub: https://github.com/biomech-gil/kinetutor
