// 16ane dashboard: owner and provider screens over the testnet sandbox.
// No keys, no secrets, no build step: the connected wallet signs everything
// (transactions and personal_sign messages) and this page only reads chain
// state, calls the public sandbox API, and renders the answers.
import { NETWORK } from "./network.js";
import { isAddress, parseUnits } from "./abi.js";
import {
  ensureChain,
  friendlyWalletError,
  hasWallet,
  personalSign,
  requestAccounts,
  sendTransaction,
  watchAsset,
} from "./provider.js";
import {
  accountingSummary,
  contracts,
  createVaultData,
  faucetClaimData,
  faucetNextClaimTime,
  faucetRemainingDaily,
  paymentRecord,
  predictVaultAddress,
  randomBytes32,
  resolveContracts,
  revokeData,
  setPolicyData,
  tokenBalanceOf,
  vaultsByOwner,
  withdrawData,
} from "./contracts.js";
import { controlCampaign, campaignControlMessage, getReceipt, listCampaigns, listServices } from "./api.js";
import {
  currentRoute,
  el,
  explorerAddressUrl,
  fmtTane,
  fmtTime,
  setBusy,
  setStatus,
  shortAddr,
  showRoute,
  txLink,
} from "./ui.js";

const state = { account: null, contracts: null, openVault: null };

function storeKey(suffix) {
  return `16ane.dashboard.${suffix}.${NETWORK.chainId}.${(state.account ?? "anon").toLowerCase()}`;
}

function recentVaults() {
  try {
    const ids = JSON.parse(localStorage.getItem(storeKey("vaults")) ?? "[]");
    return Array.isArray(ids) ? ids.filter(isAddress) : [];
  } catch {
    return [];
  }
}

function rememberVault(address) {
  const ids = [address, ...recentVaults().filter((v) => v.toLowerCase() !== address.toLowerCase())].slice(0, 12);
  try {
    localStorage.setItem(storeKey("vaults"), JSON.stringify(ids));
    localStorage.setItem(storeKey("open"), address);
  } catch {
    // Private mode: the dashboard works, it just forgets.
  }
}

function fail(err, what) {
  console.error(what, err);
  setStatus(`${what}: ${friendlyWalletError(err)}`, "error");
}

async function withContracts() {
  if (!state.contracts) state.contracts = await resolveContracts();
  return state.contracts;
}

async function refreshNetworkLine() {
  const line = document.getElementById("network-line");
  const foot = document.getElementById("contracts-line");
  try {
    const c = await withContracts();
    line.textContent = `Network: ${NETWORK.chainName} (chain ${NETWORK.chainId}). tANE: ${c.aneTestToken}.`;
    foot.textContent = `Contracts: token ${shortAddr(c.aneTestToken)}, factory ${shortAddr(c.aneVaultFactory)}, faucet ${shortAddr(c.aneFaucet)}.`;
  } catch (err) {
    line.textContent = `Network: ${NETWORK.chainName} (chain ${NETWORK.chainId}). Contract lookup failed.`;
    foot.textContent = "Contracts: unavailable.";
    console.error("contracts", err);
  }
}

async function connect() {
  const button = document.getElementById("connect");
  setBusy(button, true, "Connecting…");
  try {
    const [account] = await requestAccounts();
    await ensureChain();
    state.account = account;
    const badge = document.getElementById("wallet-address");
    badge.textContent = shortAddr(account);
    badge.hidden = false;
    button.textContent = "Connected";
    setStatus(`Connected as ${shortAddr(account)} on ${NETWORK.chainName}.`, "ok");
    await refreshAll();
  } catch (err) {
    fail(err, "Could not connect the wallet");
  } finally {
    setBusy(button, false);
  }
}

function requireAccount() {
  if (!state.account) {
    setStatus("Connect a wallet first.", "error");
    return false;
  }
  return true;
}

async function refreshAll() {
  await refreshNetworkLine();
  await Promise.allSettled([refreshOverview(), refreshFaucet(), refreshVaults(), refreshEarn(), refreshCampaigns()]);
}

// --- Overview ---

async function refreshOverview() {
  if (!state.account) return;
  try {
    const c = await withContracts();
    const [wallet, vaults] = await Promise.all([
      tokenBalanceOf(c.aneTestToken, state.account),
      vaultsByOwner(c.aneVaultFactory, state.account),
    ]);
    document.getElementById("stat-wallet").textContent = fmtTane(wallet);
    const open = state.openVault && vaults.some((v) => v.toLowerCase() === state.openVault.toLowerCase())
      ? state.openVault
      : vaults[0] ?? recentVaults()[0] ?? null;
    if (!open) {
      for (const id of ["stat-vault", "stat-spendable", "stat-revenue"]) {
        document.getElementById(id).textContent = "—";
      }
      return;
    }
    state.openVault = open;
    const summary = await accountingSummary(open);
    document.getElementById("stat-vault").textContent = fmtTane(summary.tokenBalance);
    document.getElementById("stat-spendable").textContent = fmtTane(summary.spendableNow);
    document.getElementById("stat-revenue").textContent = fmtTane(summary.verifiedRevenue);
  } catch (err) {
    console.error("overview", err);
  }
}

async function addToken() {
  const button = document.getElementById("add-token");
  setBusy(button, true, "Waiting for wallet…");
  try {
    // The network check comes first: adding the token while the wallet sits on
    // another chain would attach the address to the wrong network (#17).
    await ensureChain();
    const c = await withContracts();
    await watchAsset({
      address: c.aneTestToken,
      symbol: NETWORK.assetSymbol ?? "tANE",
      decimals: NETWORK.assetDecimals ?? 18,
      image: "https://16ane.com/mark-square.png",
    });
    setStatus("tANE was offered to the wallet. It stays a test token with no cash value.", "ok");
  } catch (err) {
    fail(err, "Could not add tANE to the wallet");
  } finally {
    setBusy(button, false);
  }
}

// --- Fund ---

async function refreshFaucet() {
  try {
    const c = await withContracts();
    const [balance, remaining] = await Promise.all([
      tokenBalanceOf(c.aneTestToken, c.aneFaucet),
      faucetRemainingDaily(c.aneFaucet),
    ]);
    document.getElementById("faucet-balance").textContent = fmtTane(balance);
    if (!state.account) return;
    const next = await faucetNextClaimTime(c.aneFaucet, state.account);
    const now = Math.floor(Date.now() / 1000);
    document.getElementById("faucet-used").textContent = next <= now ? "eligible now" : "cooling down";
    document.getElementById("faucet-next").textContent = next <= now ? "now" : fmtTime(next);
    document.getElementById("faucet-balance").textContent = `${fmtTane(balance)} (${fmtTane(remaining)} left today)`;
  } catch (err) {
    console.error("faucet", err);
  }
}

async function claimFaucet(event) {
  event.preventDefault();
  if (!requireAccount()) return;
  const to = document.getElementById("faucet-to").value.trim();
  if (!isAddress(to)) {
    setStatus("Recipient is not an address.", "error");
    return;
  }
  const button = document.getElementById("faucet-claim");
  setBusy(button, true, "Confirm in wallet…");
  try {
    await ensureChain();
    const c = await withContracts();
    const sent = await sendTransaction({ from: state.account, to: c.aneFaucet, data: faucetClaimData(to) });
    setStatus("Claim confirmed.", "ok");
    document.getElementById("status").append(" ", txLink(sent.txHash));
    await Promise.all([refreshFaucet(), refreshOverview()]);
  } catch (err) {
    fail(err, "Faucet claim failed");
  } finally {
    setBusy(button, false);
  }
}

// --- Vaults ---

async function refreshVaults() {
  const list = document.getElementById("vault-list");
  list.replaceChildren();
  let owned = [];
  try {
    if (state.account) {
      const c = await withContracts();
      owned = await vaultsByOwner(c.aneVaultFactory, state.account);
    }
  } catch (err) {
    console.error("vaults", err);
  }
  const ids = [...owned, ...recentVaults().filter((v) => !owned.some((o) => o.toLowerCase() === v.toLowerCase()))];
  if (ids.length === 0) {
    list.append(el("li", { class: "muted", text: state.account ? "No vaults yet. Create one above." : "Connect a wallet to list its vaults." }));
  }
  for (const address of ids) {
    const open = el("button", { type: "button", class: "button small", text: `Open ${shortAddr(address)}` });
    open.addEventListener("click", () => openVault(address));
    const url = explorerAddressUrl(address);
    const row = el("li", {}, [el("code", { text: address }), el("span", { text: " " }), open]);
    if (url) row.append(el("span", { text: " " }), el("a", { href: url, target: "_blank", rel: "noopener", text: "Explorer" }));
    list.append(row);
  }
  const last = state.openVault ?? (state.account ? localStorage.getItem(storeKey("open")) : null);
  if (last && isAddress(last)) await openVault(last, { quiet: true });
}

async function createVault(event) {
  event.preventDefault();
  if (!requireAccount()) return;
  const form = document.getElementById("vault-create-form");
  const button = form.querySelector("button[type=submit]");
  setBusy(button, true, "Confirm in wallet…");
  try {
    await ensureChain();
    const c = await withContracts();
    const salt = randomBytes32();
    const predicted = await predictVaultAddress(c.aneVaultFactory, state.account, salt);
    const sent = await sendTransaction({
      from: state.account,
      to: c.aneVaultFactory,
      data: createVaultData(state.account, salt),
    });
    rememberVault(predicted);
    setStatus(`Vault ${shortAddr(predicted)} created. Fund it, then delegate a budget.`, "ok");
    document.getElementById("status").append(" ", txLink(sent.txHash));
    form.reset();
    await Promise.all([refreshVaults(), refreshOverview()]);
    await openVault(predicted);
  } catch (err) {
    fail(err, "Vault creation failed");
  } finally {
    setBusy(button, false);
  }
}

async function openVault(address, { quiet = false } = {}) {
  if (!isAddress(address)) {
    if (!quiet) setStatus("That is not a vault address.", "error");
    return;
  }
  state.openVault = address;
  rememberVault(address);
  document.getElementById("vault-detail").hidden = false;
  document.getElementById("vault-detail-address").textContent = shortAddr(address);
  try {
    const summary = await accountingSummary(address);
    document.getElementById("vault-balance").textContent = fmtTane(summary.tokenBalance);
    document.getElementById("vault-spendable").textContent = fmtTane(summary.spendableNow);
    document.getElementById("vault-spent").textContent = fmtTane(summary.cumulativeSpent);
    document.getElementById("vault-agent-signer").textContent = shortAddr(summary.agentSigner);
    document.getElementById("vault-mode").textContent = summary.budgetMode;
    document.getElementById("vault-status").textContent = summary.active ? "active" : "revoked";
    await refreshOverview();
  } catch (err) {
    fail(err, "Could not read the vault");
  }
}

async function revokeVault() {
  if (!requireAccount() || !state.openVault) return;
  const button = document.getElementById("vault-revoke");
  setBusy(button, true, "Confirm in wallet…");
  try {
    await ensureChain();
    const sent = await sendTransaction({ from: state.account, to: state.openVault, data: revokeData() });
    setStatus("Agent revoked. Outstanding authorizations from its key stopped working.", "ok");
    document.getElementById("status").append(" ", txLink(sent.txHash));
    await openVault(state.openVault, { quiet: true });
  } catch (err) {
    fail(err, "Revocation failed");
  } finally {
    setBusy(button, false);
  }
}

async function withdrawVault() {
  if (!requireAccount() || !state.openVault) return;
  const button = document.getElementById("vault-withdraw");
  setBusy(button, true, "Reading vault…");
  try {
    const summary = await accountingSummary(state.openVault);
    if (summary.unallocatedBalance <= 0n) {
      setStatus("Nothing to withdraw: the vault holds no unallocated balance.", "error");
      return;
    }
    await ensureChain();
    setBusy(button, true, "Confirm in wallet…");
    const sent = await sendTransaction({
      from: state.account,
      to: state.openVault,
      data: withdrawData(summary.unallocatedBalance, state.account),
    });
    setStatus(`Withdrew ${fmtTane(summary.unallocatedBalance)} to your wallet.`, "ok");
    document.getElementById("status").append(" ", txLink(sent.txHash));
    await openVault(state.openVault, { quiet: true });
  } catch (err) {
    fail(err, "Withdrawal failed");
  } finally {
    setBusy(button, false);
  }
}

// --- Delegate ---

async function delegate(event) {
  event.preventDefault();
  if (!requireAccount()) return;
  if (!state.openVault) {
    setStatus("Open a vault first, on the Vaults screen.", "error");
    return;
  }
  const agent = document.getElementById("delegate-agent").value.trim();
  let maxTotal;
  let maxPerTx;
  try {
    maxTotal = parseUnits(document.getElementById("delegate-max").value, NETWORK.assetDecimals ?? 18);
    maxPerTx = parseUnits(document.getElementById("delegate-per-tx").value || "0", NETWORK.assetDecimals ?? 18);
  } catch (err) {
    setStatus(`Budget is not a valid amount: ${err instanceof Error ? err.message : err}`, "error");
    return;
  }
  if (!isAddress(agent)) {
    setStatus("Agent signer is not an address.", "error");
    return;
  }
  const button = document.querySelector("#delegate-form button[type=submit]");
  setBusy(button, true, "Confirm in wallet…");
  try {
    await ensureChain();
    // Bounded by maximum total spend (daily limit and expiry left open, fixed mode):
    // 0 means "none" for the open knobs, per the vault's limit semantics.
    const data = setPolicyData({
      agentSigner: agent,
      maxTotalSpend: maxTotal,
      maxPerTx,
      dailyLimit: 0n,
      expiry: 0,
      budgetMode: "FIXED",
      revolvingTreasuryCeiling: 0n,
    });
    const sent = await sendTransaction({ from: state.account, to: state.openVault, data });
    setStatus(`Delegated ${fmtTane(maxTotal)} to ${shortAddr(agent)}.`, "ok");
    document.getElementById("status").append(" ", txLink(sent.txHash));
    await openVault(state.openVault, { quiet: true });
  } catch (err) {
    fail(err, "Delegation failed");
  } finally {
    setBusy(button, false);
  }
}

// --- Earn ---

async function refreshEarn() {
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

async function refreshCampaigns() {
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

async function controlCampaignSubmit(event, action) {
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

// --- Activity ---

async function lookupPayment(event) {
  event.preventDefault();
  const id = document.getElementById("payment-id").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    setStatus("Payment id is not a 32-byte hex value.", "error");
    return;
  }
  setStatus("Looking up the payment…");
  try {
    // The receipt names the payer vault, which scopes the on-chain lookup.
    const receipt = await getReceipt(id).catch(() => null);
    const candidates = [
      receipt && typeof receipt.payer === "string" ? receipt.payer : null,
      state.openVault,
      ...recentVaults(),
    ].filter((v) => v && isAddress(v));
    let record = null;
    for (const vault of candidates) {
      const candidate = await paymentRecord(vault, id);
      if (candidate && (candidate.settledAt > 0 || candidate.amountPaid > 0n)) {
        record = candidate;
        break;
      }
    }
    if (!record) {
      setStatus("No settled payment with that id in the receipt index or your vaults.", "error");
      document.getElementById("payment-result").hidden = true;
      return;
    }
    document.getElementById("payment-merchant").textContent = shortAddr(record.merchant);
    document.getElementById("payment-paid").textContent = fmtTane(record.amountPaid);
    document.getElementById("payment-refunded").textContent = fmtTane(record.amountRefunded);
    document.getElementById("payment-settled").textContent = fmtTime(record.settledAt);
    const receiptCell = document.getElementById("payment-receipt");
    receiptCell.replaceChildren();
    if (receipt && typeof receipt.txHash === "string") {
      receiptCell.append(txLink(receipt.txHash, "Settlement transaction"));
    } else {
      receiptCell.textContent = "no sandbox receipt";
    }
    document.getElementById("payment-result").hidden = false;
    setStatus("Payment found.", "ok");
  } catch (err) {
    fail(err, "Payment lookup failed");
  }
}

// --- Init ---

function init() {
  showRoute(currentRoute(), { focus: false });
  window.addEventListener("hashchange", () => showRoute(currentRoute()));
  document.getElementById("connect").addEventListener("click", connect);
  document.getElementById("add-token").addEventListener("click", addToken);
  document.getElementById("faucet-form").addEventListener("submit", claimFaucet);
  document.getElementById("faucet-fill").addEventListener("click", () => {
    if (requireAccount()) document.getElementById("faucet-to").value = state.account;
  });
  document.getElementById("vault-create-form").addEventListener("submit", createVault);
  document.getElementById("vault-open-form").addEventListener("submit", (event) => {
    event.preventDefault();
    openVault(document.getElementById("vault-address").value.trim());
  });
  document.getElementById("vault-revoke").addEventListener("click", revokeVault);
  document.getElementById("vault-withdraw").addEventListener("click", withdrawVault);
  document.getElementById("delegate-form").addEventListener("submit", delegate);
  document.getElementById("campaign-control-form").addEventListener("submit", (event) => {
    const action = event.submitter && event.submitter.value === "resume" ? "resume" : "pause";
    controlCampaignSubmit(event, action);
  });
  document.getElementById("payment-form").addEventListener("submit", lookupPayment);
  if (hasWallet() && window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => window.location.reload());
    window.ethereum.on?.("chainChanged", () => window.location.reload());
  }
  refreshNetworkLine();
  refreshEarn();
  refreshCampaigns();
  if (!hasWallet()) {
    setStatus("No wallet detected. Balances load after you connect; the directory above needs none.");
  }
}

init();
