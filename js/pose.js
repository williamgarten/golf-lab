// Body tracking with MediaPipe Pose (Google, free and open source, Apache 2.0).
// It runs on the phone; video never leaves it. The library (~10 MB with the model)
// downloads the first time, then the service worker keeps a copy for offline use.
const VER = '0.10.14';
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarker = null, loading = null, lastTs = 0;

export function loadPose() {
  if (landmarker) return Promise.resolve(landmarker);
  if (!loading) {
    loading = (async () => {
      const vision = await import(`${LIB}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${LIB}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { landmarker = await vision.PoseLandmarker.createFromOptions(files, opts('GPU')); }
      catch { landmarker = await vision.PoseLandmarker.createFromOptions(files, opts('CPU')); }
      return landmarker;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// One frame (video element or canvas) -> 33 landmarks [{x, y, v}] or null.
export function detectPose(source) {
  if (!landmarker) return null;
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));   // must keep increasing
  const r = landmarker.detectForVideo(source, lastTs);
  const lm = r?.landmarks?.[0];
  return lm ? lm.map((p) => ({ x: p.x, y: p.y, v: p.visibility ?? 1 })) : null;
}
