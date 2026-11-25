import { CHAINS } from "./config.js";
import { fetchTelemetry, findBestRoutes } from "./engine.js";

const state = {
  chainId: "arbitrum",
  tokenSymbol: "WBTC",
  unit: "USD", // "USD" or "BTC"
  inputValue: 20000,
  tranches: 1,
  sortBy: "net", // "net" | "speed" | "steps"
  filterNoUsd: false,
  telemetry: null,
  lastResult: null,
  isLoading: false,
};

// DOM refs
const el = {
  chainPills: document.getElementById("chain-pills"),
  tokenPills: document.getElementById("token-pills"),
  contractAddr: document.getElementById("contract-addr"),
  btnCopyContract: document.getElementById("btn-copy-contract"),
  amountInput: document.getElementById("amount-input"),
  amountPrefix: document.getElementById("amount-prefix"),
  amountEquiv: document.getElementById("amount-equiv"),
  tranchesSelect: document.getElementById("tranches-select"),
  utxoHint: document.getElementById("utxo-hint"),
  btnSearch: document.getElementById("btn-search"),
  btnSearchText: document.getElementById("btn-search-text"),
  statusPills: document.getElementById("status-pills"),
  teleBtcPrice: document.getElementById("tele-btc-price"),
  teleSrcPeg: document.getElementById("tele-src-peg"),
  teleMempool: document.getElementById("tele-mempool"),
  teleUpdated: document.getElementById("tele-updated"),
  resultsCount: document.getElementById("results-count"),
  winnerBanner: document.getElementById("winner-banner"),
  loadingState: document.getElementById("loading-state"),
  routesList: document.getElementById("routes-list"),
  unavailableSection: document.getElementById("unavailable-section"),
  unavailableCount: document.getElementById("unavailable-count"),
  unavailableList: document.getElementById("unavailable-list"),
  filterNoUsd: document.getElementById("filter-no-usd"),
};

function fmtUsd(val) {
  const abs = Math.abs(val);
  const s = abs.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${val < 0 ? "-" : ""}$${s}`;
}

function fmtPct(val) {
  return `${val >= 0 ? "+" : ""}${val.toFixed(3)}%`;
}

function getTotalAmountBtc() {
  const btcPrice = state.telemetry?.tokenPrice || state.telemetry?.btcPrice || 60000;
  const v = parseFloat(el.amountInput.value) || 0;
  return state.unit === "USD" ? v / btcPrice : v;
}

function updateEquivDisplay() {
  const btcPrice = state.telemetry?.tokenPrice || state.telemetry?.btcPrice || 0;
  const v = parseFloat(el.amountInput.value) || 0;
  if (!btcPrice) {
    el.amountEquiv.textContent = "—";
    return;
  }
  if (state.unit === "USD") {
    const btc = v / btcPrice;
    el.amountEquiv.textContent = `≈ ${btc.toFixed(6)} ${state.tokenSymbol}`;
  } else {
    const usd = v * btcPrice;
    el.amountEquiv.textContent = `≈ ${fmtUsd(usd)}`;
  }
  updateUtxoHint();
}

function updateUtxoHint() {
  const t = state.tranches;
  const btcTotal = getTotalAmountBtc();
  const perTx = btcTotal / t;
  const perTxUsd = perTx * (state.telemetry?.btcPrice || 0);
  if (t === 1) {
    el.utxoHint.className = "hint";
    el.utxoHint.textContent = "Recomendación: haz primero una prueba pequeña (~$800–$1k) antes de enviar el importe principal.";
  } else if (t <= 3) {
    el.utxoHint.className = "hint";
    el.utxoHint.textContent = `Cada tramo: ${perTx.toFixed(5)} BTC (${fmtUsd(perTxUsd)}). Buen equilibrio entre seguridad y UTXOs limpios.`;
  } else {
    el.utxoHint.className = "hint warn";
    el.utxoHint.textContent = `⚠️ ${t} tramos (${perTx.toFixed(5)} BTC c/u) crean ${t} UTXOs en tu wallet Bitcoin y multiplican ×${t} las comisiones futuras al moverlos.`;
  }
}

function renderChains() {
  el.chainPills.innerHTML = "";
  Object.values(CHAINS).forEach((chain) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pill-btn ${chain.id === state.chainId ? "active" : ""}`;
    btn.innerHTML = `<span class="chain-dot" style="background:${chain.color}"></span>${chain.name}`;
    btn.addEventListener("click", () => {
      if (state.chainId === chain.id) return;
      state.chainId = chain.id;
      const availableTokens = Object.keys(chain.tokens);
      if (!availableTokens.includes(state.tokenSymbol)) {
        state.tokenSymbol = availableTokens[0];
      }
      renderChains();
      renderTokens();
      runQuoteSearch();
    });
    el.chainPills.appendChild(btn);
  });
}

function renderTokens() {
  const chain = CHAINS[state.chainId];
  el.tokenPills.innerHTML = "";
  Object.values(chain.tokens).forEach((tok) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pill-btn ${tok.symbol === state.tokenSymbol ? "active" : ""}`;
    btn.textContent = tok.symbol;
    btn.addEventListener("click", () => {
      if (state.tokenSymbol === tok.symbol) return;
      state.tokenSymbol = tok.symbol;
      renderTokens();
      runQuoteSearch();
    });
    el.tokenPills.appendChild(btn);
  });

  const activeTok = chain.tokens[state.tokenSymbol];
  el.contractAddr.textContent = activeTok.address;
  updateEquivDisplay();
}

function renderTelemetry(t) {
  el.teleBtcPrice.textContent = t.btcPrice ? fmtUsd(t.btcPrice) : "—";
  el.teleSrcPeg.textContent = `${state.tokenSymbol} ${fmtPct(t.pegPct)}`;
  el.teleSrcPeg.className = `tele-value mono ${t.pegPct >= 0.05 ? "pos" : t.pegPct <= -0.2 ? "neg" : ""}`;
  const satVb = t.mempool?.halfHourFee ?? "?";
  const txUsd = t.estBtcTxFeeBtc * t.btcPrice;
  el.teleMempool.textContent = `${satVb} sat/vB (~${fmtUsd(txUsd)})`;
  el.teleUpdated.textContent = t.timestamp.toLocaleTimeString("es-ES");
}

function renderProtocolHealth(health) {
  el.statusPills.innerHTML = "";
  Object.values(health).forEach((h) => {
    if (h.state === "unknown") return;
    const span = document.createElement("span");
    span.className = `status-pill ${h.state}`;
    const dot = h.state === "ok" ? "● " : h.state === "warn" ? "▲ " : "✕ ";
    span.textContent = `${dot}${h.label}`;
    el.statusPills.appendChild(span);
  });
}

function renderResults() {
  if (!state.lastResult) return;
  const { routes, unavailable } = state.lastResult;

  let filtered = [...routes];
  if (state.filterNoUsd) {
    filtered = filtered.filter((r) => !r.usdExposure);
  }

  if (state.sortBy === "net") {
    filtered.sort((a, b) => b.totalBtcOut - a.totalBtcOut);
  } else if (state.sortBy === "speed") {
    filtered.sort((a, b) => a.etaMinutes - b.etaMinutes || b.totalBtcOut - a.totalBtcOut);
  } else if (state.sortBy === "steps") {
    filtered.sort((a, b) => a.stepsCount - b.stepsCount || b.totalBtcOut - a.totalBtcOut);
  }

  el.resultsCount.textContent = `${filtered.length} ruta${filtered.length === 1 ? "" : "s"} activa${filtered.length === 1 ? "" : "s"}`;

  // Winner Banner
  if (filtered.length > 0) {
    const best = filtered[0];
    el.winnerBanner.classList.remove("hidden");
    const deltaClass = best.diffPct >= 0 ? "pos" : "neg";
    el.winnerBanner.innerHTML = `
      <div>
        <h3>🏆 Mejor opción ahora mismo: ${best.name}</h3>
        <p>${best.model} · Tiempo estimado: <strong>${best.etaLabel}</strong> · ${best.stepsCount} paso${best.stepsCount > 1 ? "s" : ""} · ${best.usdExposure ? "Con paso breve por USDC" : "0% exposición a USD"}</p>
      </div>
      <div class="winner-big">
        <div class="winner-btc mono">${best.totalBtcOut.toFixed(6)} BTC</div>
        <div class="winner-diff mono ${deltaClass}">${fmtPct(best.diffPct)} (${best.diffUsd >= 0 ? "+" : ""}${fmtUsd(best.diffUsd)})</div>
      </div>
    `;
  } else {
    el.winnerBanner.classList.add("hidden");
  }

  // Cards
  el.routesList.innerHTML = "";
  if (filtered.length === 0) {
    el.routesList.innerHTML = `<div class="panel"><p style="color:var(--text-muted)">No hay rutas activas que cumplan los filtros seleccionados. Prueba desactivando "0% exposición a USD" o cambiando de activo/importe.</p></div>`;
  }

  filtered.forEach((r, idx) => {
    const rank = idx + 1;
    const card = document.createElement("article");
    card.className = `route-card ${rank === 1 ? "rank-1" : ""}`;

    const deltaClass = r.diffPct >= -0.05 ? "pos" : r.diffPct >= -0.35 ? "mid" : "bad";
    const tagsHtml = r.tags
      .map((t) => {
        let cls = "";
        if (t.includes("0% exposición") || t.includes("solo 9 bps") || t.includes("Fee PLANO")) cls = "green";
        else if (t.includes("HTLC") || t.includes("Descentralizado")) cls = "blue";
        else if (t.includes("UI oficial")) cls = "btc";
        return `<span class="tag ${cls}">${t}</span>`;
      })
      .join("");

    const stepsHtml = r.steps
      .map(
        (s, i) => `
      <div class="step-row">
        <div><span class="step-num">${i + 1}</span>${s.text}</div>
        <a class="step-link" href="${s.linkUrl}" target="_blank" rel="noopener noreferrer">${s.linkLabel} ↗</a>
      </div>`
      )
      .join("");

    const perTxSub = r.tranches > 1 ? `(${r.tranches} × ${r.btcOutPerTx.toFixed(6)} BTC)` : `Tiempo: ${r.etaLabel}`;

    card.innerHTML = `
      <div class="route-top">
        <div class="route-left">
          <div class="rank-badge">#${rank}</div>
          <div>
            <div class="route-title">${r.name}</div>
            <div class="route-tags">
              <span class="tag">${r.model}</span>
              <span class="tag">${r.etaLabel}</span>
              ${tagsHtml}
            </div>
          </div>
        </div>
        <div class="route-right">
          <div class="route-btc-out mono">${r.totalBtcOut.toFixed(6)} BTC</div>
          <div class="route-delta mono ${deltaClass}">${fmtPct(r.diffPct)} (${r.diffUsd >= 0 ? "+" : ""}${fmtUsd(r.diffUsd)})</div>
          <div class="route-subdelta mono">${perTxSub}</div>
        </div>
      </div>
      <div class="route-note">${r.note}</div>
      ${r.warnNote ? `<div class="route-note warn">⚠️ ${r.warnNote}</div>` : ""}
      <details class="route-steps-details" ${rank === 1 ? "open" : ""}>
        <summary>
          <span>Ver paso a paso (${r.stepsCount} paso${r.stepsCount > 1 ? "s" : ""}) y enlaces oficiales</span>
        </summary>
        <div class="steps-list">${stepsHtml}</div>
      </details>
    `;
    el.routesList.appendChild(card);
  });

  // Unavailable list
  if (unavailable.length > 0) {
    el.unavailableSection.classList.remove("hidden");
    el.unavailableCount.textContent = String(unavailable.length);
    el.unavailableList.innerHTML = unavailable
      .map(
        (u) => `
      <div class="unavail-item">
        <strong>${u.name}</strong>
        <span>${u.reason}</span>
      </div>`
      )
      .join("");
  } else {
    el.unavailableSection.classList.add("hidden");
  }
}

async function runQuoteSearch() {
  if (state.isLoading) return;
  state.isLoading = true;
  el.btnSearch.disabled = true;
  el.btnSearch.classList.add("loading");
  el.btnSearchText.textContent = "Cotizando...";
  el.loadingState.classList.remove("hidden");
  el.winnerBanner.classList.add("hidden");

  try {
    const telemetry = await fetchTelemetry(state.chainId, state.tokenSymbol);
    state.telemetry = telemetry;
    renderTelemetry(telemetry);
    updateEquivDisplay();

    const totalAmountBtc = getTotalAmountBtc();
    if (!totalAmountBtc || totalAmountBtc <= 0) {
      throw new Error("Introduce un importe válido mayor que 0.");
    }

    const result = await findBestRoutes({
      chainId: state.chainId,
      tokenSymbol: state.tokenSymbol,
      totalAmountBtc,
      tranches: state.tranches,
      telemetry,
    });

    state.lastResult = result;
    renderProtocolHealth(result.protocolHealth);
    renderResults();
  } catch (err) {
    el.routesList.innerHTML = `<div class="panel"><p style="color:var(--red)">Error al cotizar: ${err.message}</p></div>`;
  } finally {
    state.isLoading = false;
    el.btnSearch.disabled = false;
    el.btnSearch.classList.remove("loading");
    el.btnSearchText.textContent = "Buscar mejor ruta";
    el.loadingState.classList.add("hidden");
  }
}

function wireEvents() {
  // Unit toggle
  document.querySelectorAll(".unit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextUnit = btn.dataset.unit;
      if (nextUnit === state.unit) return;
      const btcPrice = state.telemetry?.tokenPrice || state.telemetry?.btcPrice || 60000;
      const cur = parseFloat(el.amountInput.value) || 0;
      if (nextUnit === "BTC") {
        el.amountInput.value = (cur / btcPrice).toFixed(4);
        el.amountPrefix.textContent = "₿";
      } else {
        el.amountInput.value = Math.round(cur * btcPrice);
        el.amountPrefix.textContent = "$";
      }
      state.unit = nextUnit;
      document.querySelectorAll(".unit-btn").forEach((b) => b.classList.toggle("active", b.dataset.unit === nextUnit));
      updateEquivDisplay();
    });
  });

  // Amount presets
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const usd = parseFloat(btn.dataset.usd);
      document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (state.unit === "USD") {
        el.amountInput.value = usd;
      } else {
        const btcPrice = state.telemetry?.tokenPrice || state.telemetry?.btcPrice || 60000;
        el.amountInput.value = (usd / btcPrice).toFixed(4);
      }
      updateEquivDisplay();
      runQuoteSearch();
    });
  });

  el.amountInput.addEventListener("input", () => {
    document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    updateEquivDisplay();
  });

  el.amountInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runQuoteSearch();
  });

  el.tranchesSelect.addEventListener("change", () => {
    state.tranches = parseInt(el.tranchesSelect.value, 10) || 1;
    updateUtxoHint();
    runQuoteSearch();
  });

  el.btnSearch.addEventListener("click", runQuoteSearch);

  el.btnCopyContract.addEventListener("click", async () => {
    const addr = el.contractAddr.textContent;
    if (!addr || addr === "—") return;
    try {
      await navigator.clipboard.writeText(addr);
      el.btnCopyContract.textContent = "¡Copiado!";
      setTimeout(() => (el.btnCopyContract.textContent = "Copiar"), 1400);
    } catch {
      // Fallback ignored
    }
  });

  // Sort buttons
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sortBy = btn.dataset.sort;
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b.dataset.sort === state.sortBy));
      renderResults();
    });
  });

  el.filterNoUsd.addEventListener("change", () => {
    state.filterNoUsd = el.filterNoUsd.checked;
    renderResults();
  });
}

// Init
renderChains();
renderTokens();
wireEvents();
runQuoteSearch();
