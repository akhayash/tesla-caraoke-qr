"use strict";

const SCAN_INTERVAL_MS = 120;

const elements = {
  intro: document.querySelector("#intro"),
  scanner: document.querySelector("#scanner"),
  result: document.querySelector("#result"),
  error: document.querySelector("#error"),
  camera: document.querySelector("#camera"),
  canvas: document.querySelector("#decodeCanvas"),
  scanButton: document.querySelector("#scanButton"),
  uploadButton: document.querySelector("#uploadButton"),
  fileInput: document.querySelector("#fileInput"),
  cancelButton: document.querySelector("#cancelButton"),
  scanAgainButton: document.querySelector("#scanAgainButton"),
  openButton: document.querySelector("#openButton"),
  resultTitle: document.querySelector("#resultTitle"),
  resultMessage: document.querySelector("#resultMessage"),
  detectedValue: document.querySelector("#detectedValue"),
  statusIcon: document.querySelector("#statusIcon"),
  debugButton: document.querySelector("#debugButton"),
  debugPanel: document.querySelector("#debugPanel"),
  debugUserAgent: document.querySelector("#debugUserAgent"),
  debugMedia: document.querySelector("#debugMedia"),
  debugDetector: document.querySelector("#debugDetector"),
  debugDecoder: document.querySelector("#debugDecoder"),
  debugCamera: document.querySelector("#debugCamera"),
  debugPass: document.querySelector("#debugPass"),
  debugDetected: document.querySelector("#debugDetected"),
};

let stream = null;
let detector = null;
let scanning = false;
let decodeInProgress = false;
let lastScanAt = 0;
let passCursor = 0;
let detectedHttpsUrl = null;

function log(message, detail) {
  if (detail === undefined) {
    console.info(`[Tesla Caraoke QR] ${message}`);
  } else {
    console.info(`[Tesla Caraoke QR] ${message}`, detail);
  }
}

function setDebug(field, value) {
  const target = elements[field];
  if (target) {
    target.textContent = String(value);
  }
}

function showOnly(section) {
  elements.intro.classList.toggle("hidden", section !== "intro");
  elements.scanner.classList.toggle("hidden", section !== "scanner");
  elements.result.classList.toggle("hidden", section !== "result");
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
  log("Error", message);
}

function clearError() {
  elements.error.textContent = "";
  elements.error.classList.add("hidden");
}

function getDecoderName() {
  if (detector) {
    return "BarcodeDetector";
  }
  return typeof window.jsQR === "function" ? "jsQR fallback" : "Unavailable";
}

async function initializeDetector() {
  if (!("BarcodeDetector" in window)) {
    setDebug("debugDetector", "No");
    setDebug("debugDecoder", getDecoderName());
    return;
  }

  try {
    if (typeof BarcodeDetector.getSupportedFormats === "function") {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) {
        throw new Error("QR format is not supported");
      }
    }
    detector = new BarcodeDetector({ formats: ["qr_code"] });
    setDebug("debugDetector", "Yes (QR supported)");
  } catch (error) {
    detector = null;
    setDebug("debugDetector", `Present, unavailable: ${error.message}`);
    log("BarcodeDetector initialization failed; using jsQR", error);
  }

  setDebug("debugDecoder", getDecoderName());
}

function stopCamera(status = "Stopped") {
  scanning = false;
  decodeInProgress = false;

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
  }

  elements.camera.srcObject = null;
  setDebug("debugCamera", status);
  log(`Camera ${status.toLowerCase()}`);
}

function resetResult() {
  detectedHttpsUrl = null;
  elements.openButton.classList.add("hidden");
  elements.detectedValue.textContent = "";
  setDebug("debugDetected", "None");
}

async function startCamera() {
  clearError();
  resetResult();

  if (!window.isSecureContext) {
    showError("Camera access requires a secure HTTPS page.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showError("Camera access is not supported by this browser. Try Upload QR Image.");
    setDebug("debugCamera", "getUserMedia unavailable");
    return;
  }

  showOnly("scanner");
  setDebug("debugCamera", "Requesting permission");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    elements.camera.srcObject = stream;
    await elements.camera.play();
    scanning = true;
    lastScanAt = 0;
    passCursor = 0;
    setDebug("debugCamera", "Active");
    log("Camera active", stream.getVideoTracks()[0]?.getSettings?.() || {});
    window.requestAnimationFrame(scanCameraFrame);
  } catch (error) {
    stopCamera("Failed");
    showOnly("intro");

    const messages = {
      NotAllowedError: "Camera permission was denied. Allow camera access and try again.",
      NotFoundError: "No usable camera was found.",
      NotReadableError: "The camera is unavailable. Put the vehicle in Park and try again.",
      OverconstrainedError: "The available camera does not support the requested settings.",
      SecurityError: "The browser blocked camera access on this page.",
    };
    showError(messages[error.name] || `Could not start the camera: ${error.message}`);
  }
}

// Photographing a screen produces moire interference that hides QR modules.
// Aggressive downscaling averages that interference away, so the passes sweep
// from large (small QR far from the camera) to small (close-up moire-heavy).
const DECODE_PASSES = [
  { region: "full", width: 1024, filter: "none" },
  { region: "center", width: 640, filter: "none" },
  { region: "full", width: 512, filter: "none" },
  { region: "center", width: 320, filter: "none" },
  { region: "full", width: 300, filter: "none" },
  { region: "full", width: 256, filter: "otsu" },
  { region: "center", width: 256, filter: "median" },
  { region: "full", width: 200, filter: "median" },
];

const CENTER_REGION_RATIO = 0.8;

function renderRegion(source, sourceWidth, sourceHeight, region, maxWidth) {
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (region === "center") {
    const size = Math.round(Math.min(sourceWidth, sourceHeight) * CENTER_REGION_RATIO);
    sx = Math.round((sourceWidth - size) / 2);
    sy = Math.round((sourceHeight - size) / 2);
    sw = size;
    sh = size;
  }

  // Downscaling averages neighbouring pixels, which suppresses moire banding.
  const scale = Math.min(1, maxWidth / sw);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const context = elements.canvas.getContext("2d", { willReadFrequently: true });

  elements.canvas.width = width;
  elements.canvas.height = height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function toGrayscale(imageData) {
  const { data } = imageData;
  const gray = new Uint8ClampedArray(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

function medianFilter3(gray, width, height) {
  const output = new Uint8ClampedArray(gray.length);
  const window = new Uint8Array(9);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        output[index] = gray[index];
        continue;
      }

      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          window[count] = gray[index + dy * width + dx];
          count += 1;
        }
      }
      // Insertion sort is fastest for nine values.
      for (let i = 1; i < 9; i += 1) {
        const value = window[i];
        let j = i - 1;
        while (j >= 0 && window[j] > value) {
          window[j + 1] = window[j];
          j -= 1;
        }
        window[j + 1] = value;
      }
      output[index] = window[4];
    }
  }
  return output;
}

function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    histogram[gray[i]] += 1;
  }

  const total = gray.length;
  let sum = 0;
  for (let level = 0; level < 256; level += 1) {
    sum += level * histogram[level];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = -1;
  let threshold = 127;

  for (let level = 0; level < 256; level += 1) {
    weightBackground += histogram[level];
    if (weightBackground === 0) {
      continue;
    }
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) {
      break;
    }

    sumBackground += level * histogram[level];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = level;
    }
  }
  return threshold;
}

function grayToRgba(gray) {
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    rgba[i] = gray[p];
    rgba[i + 1] = gray[p];
    rgba[i + 2] = gray[p];
    rgba[i + 3] = 255;
  }
  return rgba;
}

function applyFilter(imageData, filter) {
  if (filter === "none") {
    return imageData.data;
  }

  let gray = toGrayscale(imageData);
  if (filter === "median") {
    gray = medianFilter3(gray, imageData.width, imageData.height);
  }

  const threshold = otsuThreshold(gray);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = gray[i] > threshold ? 255 : 0;
  }
  return grayToRgba(gray);
}

function decodeWithJsQr(source, sourceWidth, sourceHeight, pass) {
  if (typeof window.jsQR !== "function") {
    return null;
  }

  const imageData = renderRegion(source, sourceWidth, sourceHeight, pass.region, pass.width);
  const pixels = applyFilter(imageData, pass.filter);
  const result = window.jsQR(pixels, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  return result?.data || null;
}

async function decodeWithBarcodeDetector(source) {
  if (!detector) {
    return null;
  }

  try {
    const barcodes = await detector.detect(source);
    return barcodes.find((barcode) => barcode.rawValue)?.rawValue || null;
  } catch (error) {
    log("BarcodeDetector failed; falling back to jsQR", error);
    return null;
  }
}

// Live scanning runs one pass per frame to stay responsive; uploads run them all.
async function decodeSource(source, width, height, { passes = DECODE_PASSES } = {}) {
  if (!width || !height) {
    return null;
  }

  const nativeValue = await decodeWithBarcodeDetector(source);
  if (nativeValue) {
    setDebug("debugPass", "BarcodeDetector");
    return nativeValue;
  }

  for (const pass of passes) {
    const value = decodeWithJsQr(source, width, height, pass);
    if (value) {
      const label = `jsQR ${pass.region}/${pass.width}px/${pass.filter}`;
      setDebug("debugPass", label);
      log("Decoded", label);
      return value;
    }
  }
  return null;
}

async function scanCameraFrame(timestamp) {
  if (!scanning) {
    return;
  }

  if (
    !decodeInProgress &&
    elements.camera.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    timestamp - lastScanAt >= SCAN_INTERVAL_MS
  ) {
    decodeInProgress = true;
    lastScanAt = timestamp;

    try {
      const pass = DECODE_PASSES[passCursor % DECODE_PASSES.length];
      passCursor += 1;
      const value = await decodeSource(
        elements.camera,
        elements.camera.videoWidth,
        elements.camera.videoHeight,
        { passes: [pass] },
      );
      if (value) {
        handleDetectedValue(value);
        return;
      }
    } catch (error) {
      log("Frame decode failed", error);
    } finally {
      decodeInProgress = false;
    }
  }

  if (scanning) {
    window.requestAnimationFrame(scanCameraFrame);
  }
}

function parseHttpsUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function navigateTo(url) {
  log("Opening URL", url.href);
  window.location.assign(url.href);
}

function handleDetectedValue(rawValue) {
  if (!scanning && !elements.result.classList.contains("hidden")) {
    return;
  }

  stopCamera("Stopped after detection");
  clearError();
  resetResult();

  const value = String(rawValue).trim();
  const httpsUrl = parseHttpsUrl(value);
  setDebug("debugDetected", value || "(empty)");
  elements.detectedValue.textContent = value || "(empty QR data)";
  elements.statusIcon.textContent = "✓";
  elements.resultTitle.textContent = "QR detected";
  showOnly("result");
  log("QR detected", value);

  if (!httpsUrl) {
    elements.statusIcon.textContent = "!";
    elements.resultMessage.textContent = "This QR code is not a valid HTTPS URL and cannot be opened.";
    return;
  }

  detectedHttpsUrl = httpsUrl;

  elements.resultMessage.textContent = "Review this HTTPS URL before opening it.";
  elements.openButton.classList.remove("hidden");
}

async function decodeUploadedFile(file) {
  clearError();
  resetResult();
  setDebug("debugCamera", "Using uploaded image");

  if (!file?.type.startsWith("image/")) {
    showError("Choose an image file containing a QR code.");
    return;
  }

  let source;
  let releaseSource = () => {};
  try {
    if (typeof createImageBitmap === "function") {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
      releaseSource = () => source.close?.();
    } else {
      const objectUrl = URL.createObjectURL(file);
      source = new Image();
      source.src = objectUrl;
      await source.decode();
      releaseSource = () => URL.revokeObjectURL(objectUrl);
    }

    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    const value = await decodeSource(source, width, height);
    if (!value) {
      showError("No QR code was found in that image. Try a clearer or more tightly cropped image.");
      return;
    }
    handleDetectedValue(value);
  } catch (error) {
    showError(`Could not read the selected image: ${error.message}`);
  } finally {
    releaseSource();
    elements.fileInput.value = "";
  }
}

function returnToIntro() {
  stopCamera();
  resetResult();
  clearError();
  showOnly("intro");
}

function initializeDebugPanel() {
  setDebug("debugUserAgent", navigator.userAgent);
  setDebug("debugMedia", navigator.mediaDevices?.getUserMedia ? "Yes" : "No");
  setDebug("debugCamera", "Not started");
  setDebug("debugPass", "None");
  setDebug("debugDetected", "None");
}

elements.scanButton.addEventListener("click", startCamera);
elements.cancelButton.addEventListener("click", returnToIntro);
elements.scanAgainButton.addEventListener("click", startCamera);
elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => decodeUploadedFile(elements.fileInput.files[0]));
elements.openButton.addEventListener("click", () => {
  if (detectedHttpsUrl) {
    navigateTo(detectedHttpsUrl);
  }
});
elements.debugButton.addEventListener("click", () => {
  const isOpen = !elements.debugPanel.classList.toggle("hidden");
  elements.debugButton.setAttribute("aria-expanded", String(isOpen));
});

window.addEventListener("pagehide", () => stopCamera("Stopped on page exit"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden && stream) {
    stopCamera("Stopped while page hidden");
  }
});

initializeDebugPanel();
initializeDetector();

// Small, read-only test surface for automated checks and host configuration review.
window.teslaCaraokeQr = Object.freeze({
  parseHttpsUrl,
  handleDetectedValue,
  decodeSource,
  passes: DECODE_PASSES.map((pass) => ({ ...pass })),
});
