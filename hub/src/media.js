// Photo frame and adhan files: kept only on the hub, in data/media/ (gitignored, never uploaded anywhere else). The
// phone gets each file encrypted over the relay and keeps it in memory only (relay.sendFile, app/www/app/src/files.js).
import fs from "node:fs";
import path from "node:path";
import { newId, MAX_PHOTOS } from "./store.js";

export const MAX_PHOTO_BYTES = 1.9 * 1024 * 1024; // one relay file
export const MAX_ADHAN_BYTES = 7.5 * 1024 * 1024; // four relay files

export class Media {
  constructor({ store, dir, log = () => {} }) {
    Object.assign(this, { store, dir, log });
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[a-z0-9]{3,20}$/.test(id)) return null;
    return path.join(this.dir, `${id}.bin`);
  }

  // -> { bytes, mime, kind } or null
  read(id) {
    const s = this.store.get();
    const p = s.photos.find((x) => x.id === id);
    const a = s.adhan && s.adhan.id === id ? s.adhan : null;
    const meta = p ? { mime: "image/jpeg", kind: "photo" } : a ? { mime: a.mime, kind: "adhan" } : null;
    const f = meta && this.file(id);
    if (!f || !fs.existsSync(f)) return null;
    return { bytes: new Uint8Array(fs.readFileSync(f)), ...meta };
  }

  drop(id) {
    const f = this.file(id);
    if (f) fs.rmSync(f, { force: true });
  }

  // -> number of photos now
  addPhoto(bytes, { w = 0, h = 0 } = {}) {
    if (bytes.length > MAX_PHOTO_BYTES) throw new Error("photo too large");
    const id = newId("p");
    fs.writeFileSync(this.file(id), bytes);
    const gone = [];
    this.store.update((s) => {
      s.photos.push({ id, w, h, at: Date.now() });
      while (s.photos.length > MAX_PHOTOS) gone.push(s.photos.shift().id);
    });
    gone.forEach((g) => this.drop(g));
    return this.store.get().photos.length;
  }

  // n: 1-based, as /photos lists them. -> true if removed
  removePhoto(n) {
    const p = this.store.get().photos[n - 1];
    if (!p) return false;
    this.store.update((s) => { s.photos = s.photos.filter((x) => x.id !== p.id); });
    this.drop(p.id);
    return true;
  }

  clearPhotos() {
    const ids = this.store.get().photos.map((p) => p.id);
    this.store.update((s) => { s.photos = []; });
    ids.forEach((id) => this.drop(id));
    return ids.length;
  }

  setAdhan(bytes, mime) {
    if (bytes.length > MAX_ADHAN_BYTES) throw new Error("recording too large");
    const old = this.store.get().adhan;
    const id = newId("a");
    fs.writeFileSync(this.file(id), bytes);
    this.store.update((s) => { s.adhan = { id, mime, size: bytes.length, at: Date.now() }; });
    if (old) this.drop(old.id);
  }

  clearAdhan() {
    const old = this.store.get().adhan;
    if (!old) return false;
    this.store.update((s) => { s.adhan = null; });
    this.drop(old.id);
    return true;
  }
}
