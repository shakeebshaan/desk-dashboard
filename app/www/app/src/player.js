// /play <url>: a YouTube video or a direct https video link, full screen over the widgets; /stop (or the end of a
// direct video) brings the widgets back. YouTube runs in its privacy-enhanced embed (youtube-nocookie.com).

export function youtubeId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v");
    const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
    if (!id && m) id = m[1];
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

export class Player {
  // onEvent(state, err): "error" with a reason, so the bot can tell the owner.
  constructor({ el, onEvent = () => {} }) {
    Object.assign(this, { el, onEvent });
    this.url = null;
  }

  get playing() { return !!this.url; }

  play(url) {
    this.stop();
    const yt = youtubeId(url);
    if (!yt && !/^https:\/\/[^\s]+$/.test(url)) return this.onEvent("error", "not an https link");
    this.url = url;
    this.el.innerHTML = "";
    if (yt) {
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&playsinline=1&rel=0&modestbranding=1`;
      f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      f.referrerPolicy = "strict-origin-when-cross-origin";
      f.allowFullscreen = true;
      this.el.appendChild(f);
    } else {
      const v = document.createElement("video");
      v.src = url;
      v.autoplay = true;
      v.playsInline = true;
      v.controls = false;
      v.onended = () => this.stop();
      v.onerror = () => {
        const err = v.error ? `the phone could not play it (media error ${v.error.code})` : "the phone could not play it";
        this.stop();
        this.onEvent("error", err);
      };
      this.el.appendChild(v);
      v.play().catch(() => {});
    }
    this.el.classList.remove("hidden");
  }

  stop() {
    if (!this.url) return;
    this.url = null;
    const v = this.el.querySelector("video");
    if (v) { v.onerror = null; v.pause(); v.removeAttribute("src"); v.load(); }
    this.el.innerHTML = "";
    this.el.classList.add("hidden");
  }
}
