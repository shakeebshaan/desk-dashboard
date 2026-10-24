// Custom (generated) widget: approved HTML only, inside a sandboxed iframe with no same-origin (no storage, cookies or
// parent access) and a CSP that blocks every network request. The hub checked it before it got here.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

export default {
  type: "html",
  title: "Custom",
  mount(el, ctx, widget) {
    const f = document.createElement("iframe");
    f.className = "html-frame";
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
    el.appendChild(f);
    let html = null;
    return {
      update(state) {
        const w = state.customWidgets && state.customWidgets[widget.ref];
        const next = w ? w.html : `<p style="color:#aaa;font:16px sans-serif;text-align:center">Widget not available</p>`;
        if (next === html) return;
        html = next;
        f.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:transparent;color:#eef3ff">${html}</body></html>`;
      },
    };
  },
};
