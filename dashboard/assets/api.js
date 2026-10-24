// Sandbox REST client. Reads are public; campaign control posts a provider's
// personal_sign signature (the key never leaves the provider's wallet).
import { NETWORK } from "./network.js";

async function getJson(path) {
  const res = await fetch(`${NETWORK.apiUrl.replace(/\/$/, "")}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`API ${path} failed: HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${NETWORK.apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fall through to the status error below
  }
  if (!res.ok) {
    const detail = parsed && (parsed.message || parsed.code) ? `: ${parsed.message || parsed.code}` : "";
    throw new Error(`API ${path} failed: HTTP ${res.status}${detail}`);
  }
  return parsed;
}

export function listServices() {
  return getJson("/v1/services").then((body) => (Array.isArray(body.services) ? body.services : []));
}

export function listCampaigns() {
  return getJson("/v1/campaigns").then((body) => (Array.isArray(body.campaigns) ? body.campaigns : []));
}

export function controlCampaign(campaignId, action, control) {
  return postJson(`/v1/campaigns/${encodeURIComponent(campaignId)}/${action}`, control);
}

export async function getReceipt(id) {
  try {
    return await getJson(`/v1/payments/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

// Exact message format of signCampaignControl (packages/sdk-ts/src/campaign-control.ts):
// personal_sign over this string verifies server-side.
export function campaignControlMessage({ providerId, campaignId, action, deadline }) {
  return (
    `16ane campaign control\nprovider: ${providerId.toLowerCase()}\n` +
    `campaign: ${campaignId}\naction: ${action}\ndeadline: ${deadline}`
  );
}
