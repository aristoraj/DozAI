// Custom file picker. Hides the browser's own "Choose file / No file chosen" and shows a styled button and the file name.
// The real <input type="file"> stays in place (hidden), so code that reads .files or listens for "change" keeps working.

const EMPTY = "No file chosen";

function enhance(input) {
  input.dataset.cf = "1";
  const wrap = document.createElement("div");
  wrap.className = "cf";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button ghost small";
  button.textContent = "Choose a file";
  button.disabled = input.disabled;

  const name = document.createElement("span");
  name.className = "cf-name";
  name.setAttribute("aria-live", "polite");

  const sync = () => {
    const file = input.files?.[0];
    name.textContent = file ? file.name : EMPTY;
    name.classList.toggle("has-file", !!file);
  };

  input.before(wrap);
  wrap.append(button, name, input);
  input.classList.add("cf-native");
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");

  button.addEventListener("click", () => input.click());
  input.addEventListener("change", sync);
  input.addEventListener("focus", () => button.focus()); // a <label for=...> click lands here
  sync();
}

// Screens are redrawn from HTML text, so watch for new file fields instead of wiring each one.
export function initFiles(root = document.body) {
  const scan = () => root.querySelectorAll('input[type="file"]:not([data-cf])').forEach(enhance);
  scan();
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
}
