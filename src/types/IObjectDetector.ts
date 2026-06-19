/** A bounding box in pixels (transformers.js detection output shape). */
export interface DetectionBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** One detected object: a label, the detector's score (0..1), and its box. */
export interface Detection {
  label: string;
  score: number;
  box: DetectionBox;
}

/**
 * Opt-in CV object detector (the Phase-2 pre-pass). An implementation runs a
 * detector over an image and returns confidence-tagged detections; it never
 * throws (a load/inference failure yields `[]` — no signal, like C2PA
 * `unavailable`). Detections feed both the VLM prompt context and a deterministic
 * `cv-detection` graph fragment.
 */
export interface IObjectDetector {
  detect(filePath: string): Promise<Detection[]>;
}
