# Tesla Caraoke QR Reader

A small, static QR reader designed for the Tesla in-car browser. It reads the
Stingray Karaoke Passenger App QR code shown by Caraoke, displays the decoded
HTTPS URL for confirmation, and opens it only after a button press.

**GitHub Pages:** https://akhayash.github.io/tesla-caraoke-qr/

## Using it in a Tesla

1. Put the vehicle in Park.
2. Display the Caraoke passenger QR code on the rear screen.
3. Photograph the QR code with a phone.
4. Open the GitHub Pages URL in the Tesla browser.
5. Press **SCAN QR** and allow camera access.
6. Show the photo to the cabin camera so the QR code **fills the guide frame**.
7. Check the address that appears, then press **Open URL**.

Filling the frame matters: if the QR code is small in the camera view there are
too few pixels per module to decode.

## Privacy and security

- QR recognition runs entirely in the browser. Images and decoded QR data are
  not uploaded to a server.
- The browser-native `BarcodeDetector` API is used when QR support is available.
  A local copy of [jsQR](https://github.com/cozmo/jsQR) is the fallback, so QR
  processing does not require a third-party service.
- Only valid `https:` URLs can be opened. Schemes such as `javascript:`,
  `data:`, `file:`, and plain `http:` are rejected.
- Every valid HTTPS URL is shown for review and requires pressing **Open URL**.
  There is no automatic redirect or domain allowlist.

A real Tesla Caraoke QR code decodes to a Stingray companion link such as
`https://karaoke-web-companion-prod.stingray.com/join?id=...`, so check that the
displayed host looks like this before opening it.

## Reading a QR code photographed from a screen

Photographing the Tesla screen creates moire interference that hides QR modules,
and many decoders fail on such images. The reader therefore retries each frame
through several rendering passes: progressively stronger downscaling, an
optional centre crop, Otsu binarisation, and a 3x3 median filter. The pass that
succeeded is shown in the **Debug** panel.

Tips if a scan fails:

- Fill the guide frame with the QR code and hold steady for a second.
- Reduce glare and tilt the phone slightly to break up the moire pattern.
- Raise the phone's screen brightness.
- Zoom into the QR code in the phone's photo viewer so it fills the screen.

## Camera permission

Camera access requires HTTPS and explicit browser permission. Tesla may expose
the cabin camera only while the vehicle is in Park. If permission was previously
denied, use the browser's site settings to re-enable camera access.

The collapsed **Debug** panel reports camera and decoder availability, camera
state, the user agent, and the latest decoded data.

## Files

- `index.html` - page structure
- `style.css` - touch-friendly responsive layout
- `app.js` - camera, decoding, HTTPS validation, confirmation, and debug logic
- `vendor/jsQR.js` - local jsQR 1.4.0 fallback
- `vendor/jsQR.LICENSE` - jsQR Apache 2.0 license

This is an independent personal tool. It is not affiliated with, endorsed by,
or supported by Tesla Caraoke, Stingray, or Tesla, Inc.
