// Custom number fields. Hides the browser's tiny up/down arrows and adds "−" and "+" buttons.
// The real <input type="number"> stays in place, so typing, arrow keys, .value and "input" listeners keep working.

function enhance(input) {
  input.dataset.cn = "1";
  const wrap = document.createElement("div");
  wrap.className = "cn";

  const button = (sign, label, direction) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cn-step";
    b.textContent = sign;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1; // the keyboard already steps with the arrow keys inside the box
    b.addEventListener("mousedown", e => e.preventDefault()); // do not steal focus from the box
    b.addEventListener("click", () => {
      direction > 0 ? input.stepUp() : input.stepDown(); // respects min, max and step
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      refresh();
    });
    return b;
  };
  const down = button("−", "Decrease", -1), up = button("+", "Increase", 1);
  const steps = document.createElement("div");
  steps.className = "cn-steps";
  steps.append(down, up);

  // Grey out a button when the value has reached its limit.
  const refresh = () => {
    const v = input.value === "" ? null : Number(input.value);
    down.disabled = input.disabled || (input.min !== "" && v !== null && v <= Number(input.min));
    up.disabled = input.disabled || (input.max !== "" && v !== null && v >= Number(input.max));
  };

  input.before(wrap);
  wrap.append(input, steps);
  input.addEventListener("input", refresh);
  refresh();
}

// Screens are redrawn from HTML text, so watch for new number fields instead of wiring each one.
export function initNumbers(root = document.body) {
  const scan = () => root.querySelectorAll('input[type="number"]:not([data-cn])').forEach(enhance);
  scan();
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
}
