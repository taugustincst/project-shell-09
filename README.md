# Narra

_This repo started as project-shell-09 and now holds Narra; see [HANDOFF.md](HANDOFF.md) for its history._

Narra reads things aloud. Paste text, open a PDF or Word file, or give it a link, and it reads to you while lighting up the sentence and the word it's on. Everything you add stays in a library on your device, with your place saved.

It's a plain web app (HTML, CSS and JavaScript, no build step), so it runs in any modern browser and can be installed to a phone's home screen. It can later be wrapped as an Android app (for example as a Trusted Web Activity with Bubblewrap, or with Capacitor).

## What it does

- **Read aloud** with the voices built into the device or browser (Web Speech API). Voices are grouped by language; ones that usually sound most natural are starred.
- **Speed** from 0.5× to 3×, with presets, plus pitch.
- **Follow along**: the current sentence is highlighted, and the current word too where the voice reports word positions. The page scrolls to keep up.
- **Controls**: play and pause, back or forward one sentence, skip a paragraph, drag the progress bar, or tap any sentence to start there. Keyboard: Space plays and pauses, ← and → move by sentence, Shift+←/→ by paragraph, [ and ] change speed.
- **Bring in text** by pasting (the dialog, or Ctrl+V anywhere), opening `.pdf`, `.docx`, `.txt`, `.md` or `.html` files, dragging a file onto the window, fetching a web page by link, or sharing to Narra from another app once it's installed on Android.
- **Library** of everything you've added, searchable, with progress bars and time left, saved in the browser's local storage.
- **Reading view settings**: text size, line spacing, serif or sans, light, dark or automatic theme.
- **Works offline** after the first visit (service worker), apart from opening PDF and Word files for the first time, which loads a helper from cdnjs.

## Run it

```
npm start          # serves the folder at http://localhost:8080
npm install && npm test
```

Opening `index.html` straight from disk also works, but offline caching and installing need it served over http(s).

## Known limits

- Voices come from the device, so quality and choice vary: Edge and Chrome on desktop have the best free "natural" voices; Android uses the phone's speech engine.
- Word-by-word highlighting depends on the voice reporting word boundaries. Many online voices in Chrome, and some Android engines, only give sentence highlighting.
- Many websites block other apps from loading their pages, so "Link" fails for them. Copying the page text and pasting it works instead.
- Scanned PDFs (images of text) aren't read; there's no OCR yet.
- The library lives in the browser's local storage (a few megabytes), so very large books may not fit, and it doesn't sync between devices.
- On phones, speech may stop when the screen locks; that's a browser limit that an Android wrapper can work around.

## Files

- `index.html`: layout and styles
- `core.js`: text handling (sentence splitting, HTML/Markdown/PDF text clean-up, timing), with no browser dependencies
- `app.js`: library, importers, reader and speech player
- `sw.js`, `manifest.webmanifest`, `icon*.svg`: offline support and install
- `tests/`: Node tests for `core.js`, and end-to-end tests that run the page in jsdom with a fake speech engine
