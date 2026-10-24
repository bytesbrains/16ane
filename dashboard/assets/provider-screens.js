// Provider screens: the service directory and verified revenue (Earn), and
// sponsored campaigns with the provider-signed pause/resume control.
import { ensureChain, personalSign } from "./provider.js";
import { accountingSummary } from "./contracts.js";
import { controlCampaign, campaignControlMessage, listCampaigns, listServices } from "./api.js";
import { el, fmtTane, setStatus } from "./ui.js";
import { fail, requireAccount, state } from "./session.js";

// --- Earn ---

export async function refreshEarn() {
  const list = document.getElementById("service-list");
  list.replaceChildren();
  try {
    const services = await listServices();
    if (services.length === 0) {
      list.append(el("li", { class: "muted", text: "No services are listed in the directory." }));
    }
    for (const service of services.slice(0, 50)) {
      const endpoints = Array.isArray(service.endpoints) ? service.endpoints : [];
      const prices = endpoints.map((e) => `${e.method} ${e.path}: ${e.priceAmount} base units`).join("; ");
      list.append(
        el("li", {}, [
          el("strong", { text: String(service.name ?? service.serviceId) }),
          el("br"),
          el("span", { class: "muted", text: String(service.description ?? "") }),
          el("br"),
          el("code", { text: prices || "no priced endpoints" }),
        ]),
      );
    }
  } catch (err) {
    console.error("services", err);
    list.append(el("li", { class: "muted", text: "The directory is unreachable right now." }));
  }
  try {
    if (!state.openVault) return;
    const summary = await accountingSummary(state.openVault);
    document.getElementById("revenue-verified").textContent = fmtTane(summary.verifiedRevenue);
    document.getElementById("revenue-mode").textContent = summary.budgetMode;
  } catch (err) {
    console.error("revenue", err);
  }
}

// --- Campaigns ---

export async function refreshCampaigns() {
  const list = document.getElementById("campaign-list");
  list.replaceChildren();
  try {
    const campaigns = await listCampaigns();
    if (campaigns.length === 0) {
      list.append(el("li", { class: "muted", text: "No campaigns are running." }));
    }
    for (const campaign of campaigns) {
      const quota = campaign.quota && typeof campaign.quota === "object" ? campaign.quota : {};
      list.append(
        el("li", {}, [
          el("strong", { text: `Campaign ${String(campaign.id ?? campaign.campaignId ?? "?")}` }),
          el("br"),
          el("span", {
            class: "muted",
            text: `sponsor ${String(campaign.sponsor ?? campaign.providerId ?? "?")} · ` +
              `status ${String(campaign.status ?? (campaign.paused ? "paused" : "active"))} · ` +
              `remaining ${String(quota.remaining ?? quota.remainingCalls ?? "?")}`,
          }),
        ]),
      );
    }
    document.getElementById("campaign-control-form").hidden = campaigns.length === 0;
  } catch (err) {
    console.error("campaigns", err);
    list.append(el("li", { class: "muted", text: "Campaign data is unreachable right now." }));
  }
}

export async function controlCampaignSubmit(event, action) {
  event.preventDefault();
  if (!requireAccount()) return;
  const campaignId = document.getElementById("campaign-id").value.trim();
  if (!campaignId) {
    setStatus("Enter a campaign id.", "error");
    return;
  }
  const buttons = [...document.querySelectorAll("#campaign-control-form button[type=submit]")];
  for (const b of buttons) b.disabled = true;
  try {
    await ensureChain();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const message = campaignControlMessage({ providerId: state.account, campaignId, action, deadline });
    const signature = await personalSign(message, state.account);
    await controlCampaign(campaignId, action, {
      providerId: state.account,
      campaignId,
      action,
      deadline,
      signature,
    });
    setStatus(`Campaign ${campaignId} ${action === "pause" ? "paused" : "resumed"}.`, "ok");
    await refreshCampaigns();
  } catch (err) {
    fail(err, `Could not ${action} the campaign (only its provider can)`);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}
