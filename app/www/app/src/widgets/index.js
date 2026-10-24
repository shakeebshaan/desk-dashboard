// Widget registry. A new widget type = one module exporting { type, title, mount(el, ctx, widget) -> { update, tick?, show?, hide? } }.
import age from "./age.js";
import clock from "./clock.js";
import weather from "./weather.js";
import alarms from "./alarms.js";
import agent from "./agent.js";
import board from "./board.js";
import countdown from "./countdown.js";
import prayer from "./prayer.js";
import photos from "./photos.js";
import quote from "./quote.js";
import ambient from "./ambient.js";
import html from "./html.js";
import verse from "./verse.js";
import moon from "./moon.js";
import sun from "./sun.js";

export const WIDGETS = Object.fromEntries([age, clock, weather, alarms, agent, board, countdown, prayer, photos, quote, ambient, html, verse, moon, sun].map((w) => [w.type, w]));
