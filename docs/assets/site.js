// Code Atlas site: gallery tabs and copy buttons. No dependencies.
(() => {
  const tabs = [...document.querySelectorAll('.gallery [role="tab"]')];
  const img = document.getElementById("gallery-img");
  const cap = document.getElementById("gallery-cap");

  function select(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    if (focus) tab.focus();
    if (img.getAttribute("src") === tab.dataset.src) return;
    img.classList.add("is-swapping");
    const next = new Image();
    next.onload = () => {
      img.src = tab.dataset.src;
      img.alt = tab.dataset.alt;
      cap.textContent = tab.textContent.trim().toLowerCase();
      img.classList.remove("is-swapping");
    };
    next.src = tab.dataset.src;
  }

  tabs.forEach((tab, i) => {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (step) {
        e.preventDefault();
        select(tabs[(i + step + tabs.length) % tabs.length], true);
      } else if (e.key === "Home") {
        e.preventDefault();
        select(tabs[0], true);
      } else if (e.key === "End") {
        e.preventDefault();
        select(tabs[tabs.length - 1], true);
      }
    });
  });

  // Fallback for browsers or embedded views that block the async Clipboard API.
  function legacyCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  const note = document.querySelector(".terminal__note");
  document.querySelectorAll(".copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = legacyCopy(text);
      }
      if (ok) {
        btn.textContent = "Copied";
        if (note) note.textContent = "Copied: " + text;
      } else if (note) {
        note.textContent = "Copy is unavailable here — select the command instead.";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
  });
})();
