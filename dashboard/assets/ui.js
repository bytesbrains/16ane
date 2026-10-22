// DOM helpers (textContent only — innerHTML never appears in this codebase),
// hash routing with focus management, and display formatting.
import { NETWORK } from "./network.js";
import { formatUnits } from "./abi.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "hidden") node.hidden = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export function setStatus(message, kind = "") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = kind ? `status-line ${kind}` : "status-line";
}

export function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label !== undefined) button.dataset.label = button.dataset.label ?? button.textContent;
  if (busy && label !== undefined) button.textContent = label;
  if (!busy && button.dataset.label !== undefined) button.textContent = button.dataset.label;
}

export function shortAddr(addr) {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function fmtTane(baseUnits) {
  return `${formatUnits(baseUnits, NETWORK.assetDecimals ?? 18)} tANE`;
}

export function fmtTime(unixSec) {
  if (!unixSec) return "—";
  return new Date(unixSec * 1000).toLocaleString();
}

export function explorerTxUrl(txHash) {
  return NETWORK.explorer ? `${NETWORK.explorer.replace(/\/$/, "")}/tx/${txHash}` : null;
}

export function explorerAddressUrl(address) {
  return NETWORK.explorer ? `${NETWORK.explorer.replace(/\/$/, "")}/address/${address}` : null;
}

const ROUTES = ["overview", "fund", "vaults", "delegate", "earn", "campaigns", "activity"];

export function currentRoute() {
  const hash = window.location.hash.match(/^#\/([a-z]+)/)?.[1];
  return ROUTES.includes(hash) ? hash : "overview";
}

export function showRoute(name, { focus = true } = {}) {
  const route = ROUTES.includes(name) ? name : "overview";
  for (const section of document.querySelectorAll("[data-screen]")) {
    section.hidden = section.dataset.screen !== route;
  }
  for (const link of document.querySelectorAll("[data-route]")) {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (window.location.hash !== `#/${route}`) window.location.hash = `#/${route}`;
  if (focus) {
    const heading = document.querySelector(`[data-screen="${route}"] h2`);
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  return route;
}

export function txLink(txHash, label = "View transaction") {
  const url = explorerTxUrl(txHash);
  if (!url) return el("code", { text: txHash });
  return el("a", { href: url, target: "_blank", rel: "noopener" }, [el("span", { text: label })]);
}
