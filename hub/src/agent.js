// The dashboard's agent brain: Anthropic API, called only from the hub (the key never ships in the app).
// Key: an Anthropic API key (give it a monthly limit in the Console), one line in a file in the secrets folder,
// read at run time only - never from env, never stored in state, logs or replies. No key file ->
// "agent offline"; the file is re-read, so dropping it in turns the agent on without a restart.
// Hub-side spend guard (second fence behind the Console limit): booked from each call's `usage`; one owner warning
// per month at warnUsd; at capUsd (or when a call's worst case would pass it) the request is refused and queued.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { checkWidgetHtml } from "./widgetcheck.js";

// USD per million tokens (Anthropic first-party, cached 2026-10-06). Unknown model -> refuse rather than guess.
export const PRICES = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
};

const MAX_OUT = 300;
const MAX_OUT_WIDGET = 6000;
const QUEUE_MAX = 50;

const SYSTEM = `You are the voice of a desk dashboard, an always-on phone on its owner's desk. Your reply is read aloud
by the phone's speech engine, so answer in one to three short spoken sentences: no lists, no markdown, no emojis,
no URLs. If you do not know something current (news, prices, live data), say so plainly.`;

const WIDGET_SYSTEM = `You write one self-contained dashboard widget as a single HTML document for a portrait phone
screen (390x844 CSS px, dark background). Rules: inline <style> and <script> only; no network of any kind (no fetch,
XHR, WebSocket, external src/href, CSS url() or @import), no storage, no device APIs, no eval, no parent/top access.
Animate with CSS or requestAnimationFrame. Reply with the HTML only, starting with <!doctype html>.`;

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const nextMonthKey = (d = new Date()) => monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
export const estimateTokens = (text) => Math.ceil(String(text).length / 3) + 20;

export class Agent {
  constructor({ store, enabled = true, keyFile, model, capUsd = 10, warnUsd = 8, client, onWarn = () => {}, log = () => {} }) {
    Object.assign(this, { store, switchOn: !!enabled, keyFile, model, capUsd, warnUsd, injectedClient: client, onWarn, log });
    this.price = PRICES[model];
    this.key = null;
    this.client = null;
    this.history = [];
    this.refresh();
  }

  readKey() {
    if (!this.keyFile) return "";
    try {
      return fs.readFileSync(this.keyFile, "utf8").split(/\r?\n/)[0].trim();
    } catch {
      return "";
    }
  }

  // Re-reads the key file; (re)builds the client when the key changed. Returns true when on/off flipped.
  refresh() {
    const key = this.switchOn ? this.readKey() : "";
    if (key !== this.key) {
      this.key = key;
      // Explicit key only: never fall back to ANTHROPIC_API_KEY / a CLI profile from the environment.
      this.client = key && this.price ? this.injectedClient || new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60000 }) : null;
    }
    const was = this.enabled;
    this.enabled = !!(this.switchOn && key && this.price);
    this.reasonOff = !this.switchOn ? "switched off" : !key ? "offline (no key file yet)" : !this.price ? `offline (no price for ${this.model})` : "";
    this.store.agentEnabled = this.enabled;
    if (was !== undefined && was !== this.enabled) {
      this.log(`agent ${this.enabled ? "ON (key file found)" : `off: ${this.reasonOff}`}`);
      this.store.update(() => {}); // push the new on/off state to the phone
      return true;
    }
    return false;
  }

  ledger() {
    const a = this.store.get().agent;
    if (a.month !== monthKey()) this.store.update((s) => Object.assign(s.agent, { month: monthKey(), spentUsd: 0 }), { silent: true });
    return this.store.get().agent;
  }

  status() {
    this.refresh();
    const a = this.ledger();
    return {
      enabled: this.enabled,
      reasonOff: this.reasonOff,
      model: this.model,
      month: a.month,
      spentUsd: a.spentUsd,
      capUsd: this.capUsd,
      warnUsd: this.warnUsd,
      queued: a.queue.length,
    };
  }

  cost(inTok, outTok) {
    return (inTok * this.price.in + outTok * this.price.out) / 1e6;
  }

  // Worst case for a call with this much prompt text and this output cap.
  worstCase(promptText, maxOut) {
    return this.cost(estimateTokens(promptText), maxOut);
  }

  async ask(question, { source = "telegram", maxOut = MAX_OUT, system = SYSTEM, keepHistory = true } = {}) {
    this.refresh();
    if (!this.enabled) return { ok: false, off: true, text: this.switchOn ? "Agent offline." : "The agent is switched off." };
    const a = this.ledger();
    const messages = [...(keepHistory ? this.history : []), { role: "user", content: String(question).slice(0, 4000) }];
    const promptText = system + messages.map((m) => m.content).join("\n");
    const worst = this.worstCase(promptText, maxOut);
    if (a.spentUsd >= this.capUsd || a.spentUsd + worst > this.capUsd) {
      if (a.queue.length < QUEUE_MAX) {
        this.store.update((s) => s.agent.queue.push({ question, source, at: Date.now() }), { silent: true });
      }
      return {
        ok: false,
        capped: true,
        text: `Monthly agent limit reached (${a.spentUsd.toFixed(2)} of ${this.capUsd} USD), so I can't answer until ${nextMonthKey()}. Your question is queued.`,
      };
    }
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxOut,
      system,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages,
    });
    const u = res.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
    const spent = this.cost(inTok, u.output_tokens || 0);
    this.store.update((s) => {
      s.agent.spentUsd = Math.round((s.agent.spentUsd + spent) * 1e6) / 1e6;
    }, { silent: true });
    this.checkWarn();
    if (res.stop_reason === "refusal") return { ok: false, text: "I can't help with that one.", spent };
    const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (keepHistory) {
      this.history.push({ role: "user", content: String(question) }, { role: "assistant", content: text || "..." });
      this.history = this.history.slice(-8);
    }
    return { ok: true, text: text || "(no answer)", spent, usage: u };
  }

  // One warning per calendar month once spend reaches warnUsd.
  checkWarn() {
    const a = this.ledger();
    if (a.spentUsd < this.warnUsd || a.warnedMonth === a.month) return;
    this.store.update((s) => { s.agent.warnedMonth = a.month; }, { silent: true });
    try {
      this.onWarn(`Dashboard agent spend: ${a.spentUsd.toFixed(2)} of ${this.capUsd} USD this month (warning at ${this.warnUsd}). At ${this.capUsd} it stops until ${nextMonthKey()}.`);
    } catch (e) {
      this.log(`agent warn: ${e.message}`);
    }
  }

  // Draft a custom widget; it only reaches the phone after the static check AND the owner's /approve.
  async draftWidget(description) {
    const r = await this.ask(description, { maxOut: MAX_OUT_WIDGET, system: WIDGET_SYSTEM, keepHistory: false, source: "widget" });
    if (!r.ok) return r;
    const html = r.text.replace(/^```(?:html)?\s*|\s*```$/g, "");
    return { ...r, html, check: checkWidgetHtml(html) };
  }

  // At a new month, run what was queued (oldest first) while it fits. Returns the answers for the bot to send.
  async drainQueue() {
    this.refresh();
    if (!this.enabled) return [];
    const a = this.ledger();
    const out = [];
    while (a.queue.length) {
      const item = a.queue[0];
      if (a.spentUsd + this.worstCase(SYSTEM + item.question, MAX_OUT) > this.capUsd) break;
      this.store.update((s) => s.agent.queue.shift(), { silent: true });
      const r = await this.ask(item.question, { source: item.source, keepHistory: false });
      out.push({ ...item, answer: r });
    }
    return out;
  }
}
