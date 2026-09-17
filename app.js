"use strict";

const SCAN_INTERVAL_MS = 140;
const MAX_DECODE_WIDTH = 1280;

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
  debugDetected: document.querySelector("#debugDetected"),
};

let stream = null;
let detector = null;
let scanning = false;
let decodeInProgress = false;
let lastScanAt = 0;
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

function drawSourceToCanvas(source, sourceWidth, sourceHeight) {
  const scale = Math.min(1, MAX_DECODE_WIDTH / sourceWidth);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const context = elements.canvas.getContext("2d", { willReadFrequently: true });

  elements.canvas.width = width;
  elements.canvas.height = height;
  context.drawImage(source, 0, 0, width, height);
  return { context, width, height };
}

function decodeCanvasWithJsQr(context, width, height) {
  if (typeof window.jsQR !== "function") {
    return null;
  }

  const imageData = context.getImageData(0, 0, width, height);
  const result = window.jsQR(imageData.data, width, height, {
    inversionAttempts: "attemptBoth",
  });
  return result?.data || null;
}

async function decodeSource(source, width, height) {
  if (detector) {
    try {
      const barcodes = await detector.detect(source);
      const value = barcodes.find((barcode) => barcode.rawValue)?.rawValue;
      if (value) {
        return value;
      }
    } catch (error) {
      log("BarcodeDetector frame failed; trying jsQR", error);
    }
  }

  const canvasData = drawSourceToCanvas(source, width, height);
  return decodeCanvasWithJsQr(canvasData.context, canvasData.width, canvasData.height);
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
      const value = await decodeSource(
        elements.camera,
        elements.camera.videoWidth,
        elements.camera.videoHeight,
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
});
