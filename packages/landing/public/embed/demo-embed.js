/*
 * The showcase's stand-in for a third-party embed (#551).
 *
 * It is this site's own file, published by `build.passthrough`, so the demo
 * works for a real reader and still sends no request to another origin. The
 * script layer treats it exactly as it would a vendor's: a `facade` strategy
 * behind the `functional` consent category (`../../src/features.ts`). It runs
 * only after the reader has consented and pressed the placeholder; the loader
 * removes the placeholder, and this fills the mount point it leaves.
 */
(function () {
  var mount = document.getElementById("embed-demo");
  if (mount === null) return;
  var seconds = (performance.now() / 1000).toFixed(1);
  var frame = document.createElement("div");
  frame.className = "fw-embed__loaded";
  frame.setAttribute("data-embed", "loaded");
  var title = document.createElement("p");
  title.className = "fw-embed__title";
  title.textContent = "Embed loaded";
  var note = document.createElement("p");
  note.textContent =
    "This script ran " + seconds + " s after the page opened: after you consented and pressed the button, and not before.";
  frame.appendChild(title);
  frame.appendChild(note);
  mount.appendChild(frame);
})();
