# Development

`capture.js` registers the action, shortcut and image context menu. For screenshots, it opens `editor.html` with a one-use snapshot from `snapshots.js`. `editor.js` applies edits with `drawing.js` and calls the recognition engine in `ocr.js`.

For the image context menu, `capture.js` injects `page-picture.js` into the frame where the image was clicked. `offscreen.html` runs the same local OCR engine in a hidden extension document. Both the page and the editor render selections with `word-layer.js`. The page script keeps its overlay aligned with the image's painted rectangle. Match updates to the originating document and overlay ID so that stale OCR results cannot affect a different page or image.

`disk.js` uses the signed-in Disk web interface on `disk.yandex.ru` for the explicit cloud export action. Upload the rendered PNG, share the exact generated filename, and validate the returned viewer address. Keep upload and share selectors together in `uploadAndShareOnPage`. `capture.js` handles system notification clicks so they work outside the editor. Check both the signed-out redirect and the signed-in upload and sharing interface when Yandex changes its web client.

The folder is the extension package. Load it as unpacked and use **Reload** in `chrome://extensions` after changes. The `ocr` directory contains the browser bundle, worker, all three LSTM runtime variants and both trained-data files. Keep these assets local and preserve their licenses when upgrading them.

With Node.js 22 or later, run `npm ci`, `npx playwright install chromium`, and `npm test` from the repository root. The suite uses an isolated browser profile, synthetic images, and a simulated Yandex Disk upload. Run artifacts are written under `.test-work/`.

Check modified scripts with `node --check <file>`. In Chromium, capture and crop a region, select several arrow icons, type a multiline label on the image, and apply and undo a solid redaction. Confirm that copying the image and saving a PNG close the popup on success. Start editor OCR with networking disabled. Use the image context menu to recognize a mixed Russian/English image inside a modal and on a scrolling page. Select a single letter, check the copied content, and confirm that Escape removes the layer while the modal stays open. Check the keyboard shortcut in `chrome://extensions/shortcuts`.
