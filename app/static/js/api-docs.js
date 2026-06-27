// API reference: bind every example to the host the docs are served from, wire
// copy buttons, and track the active section in the sidebar.
// Importing api.js also activates the shared tooltip / scroll-reveal layer.
import "./api.js";

const origin = location.origin;

// 1 — Domain adaptation: fill the base-URL chip and every <span class="ho">.
const baseEl = document.getElementById("base-url");
if (baseEl) baseEl.textContent = origin;
document.querySelectorAll(".ho").forEach(el => { el.textContent = origin; });

const copyBase = document.getElementById("copy-base");
if (copyBase) {
  copyBase.addEventListener("click", () => {
    navigator.clipboard.writeText(origin).catch(() => {});
    copyBase.textContent = "Copied!";
    setTimeout(() => (copyBase.textContent = "Copy"), 1500);
  });
}

// 2 — Copy buttons on every code block.
document.querySelectorAll(".code[data-copy]").forEach(block => {
  // Snapshot the code (origin already substituted) before adding the button so
  // the button's own label never leaks into the copied text.
  const text = block.textContent.trim();
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).catch(() => {});
    btn.textContent = "Copied";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
  });
  block.appendChild(btn);
});

// 3 — Scrollspy: highlight the sidebar link for the section in view.
const links = Array.from(document.querySelectorAll("#docs-nav a"));
const byId = new Map(links.map(a => [a.getAttribute("href").slice(1), a]));
const sections = links
  .map(a => document.getElementById(a.getAttribute("href").slice(1)))
  .filter(Boolean);

function setActive(id) {
  links.forEach(a => a.classList.remove("active"));
  byId.get(id)?.classList.add("active");
}

if ("IntersectionObserver" in window && sections.length) {
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target.id);
      else visible.delete(e.target.id);
    }
    // Pick the topmost section currently in view.
    const inView = sections.filter(s => visible.has(s.id));
    if (inView.length) setActive(inView[0].id);
  }, { rootMargin: "-64px 0px -70% 0px", threshold: 0 });
  sections.forEach(s => io.observe(s));
  setActive(sections[0].id);
}

// Smooth-scroll the sidebar links.
links.forEach(a => {
  a.addEventListener("click", (e) => {
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", a.getAttribute("href"));
    }
  });
});
