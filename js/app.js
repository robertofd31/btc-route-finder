import { CHAINS } from "./config.js";
import { fetchTelemetry, findBestRoutes, findBestRoutesGlobal } from "./engine.js";

const GLOBAL_TOKEN_FILTERS = ["ALL", "WBTC", "cbBTC", "tBTC", "BTC.b", "BTCB", "LBTC", "kBTC"];

const state = {
  chainId: "arbitrum", // "all" or any key in CHAINS
  tokenSymbol: "WBTC", // or "ALL" when chainId === "all"
  unit: "USD",
  tranches: 1,
  sortBy: "net",
  filterNoUsd: false,
  includeCrossChain: true,
  telemetry: null,
  lastResult: null,
  isLoading: false,
};

const el = {
  chainPills: document.getElementById("chain-pills"),
  tokenPills: document.getElementById("token-pills"),
  tokenFieldLabel: document.getElementById("token-field-label"),
  contractBar: document.getElementById("contract-bar"),
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
  resultsHeading: document.getElementById("results-heading"),
  resultsCount: document.getElementById("results-count"),
  winnerBanner: document.getElementById("winner-banner"),
  loadingState: document.getElementById("loading-state"),
  loadingDetail: document.getElementById("loading-detail"),
  routesList: document.getElementById("routes-list"),
  unavailableSection: document.getElementById("unavailable-section"),
  unavailableCount: document.getElementById("unavailable-count"),
  unavailableList: document.getElementById("unavailable-list"),
  filterNoUsd: document.getElementById("filter-no-usd"),
  filterCrossChain: document.getElementById("filter-cross-chain"),
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
  const symLabel = state.chainId === "all" && state.tokenSymbol === "ALL" ? "BTC sintético" : state.tokenSymbol;
  if (state.unit === "USD") {
    const btc = v / btcPrice;
    el.amountEquiv.textContent = `≈ ${btc.toFixed(6)} ${symLabel}`;
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

  // Global "All Chains" button first!
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `pill-btn global-pill ${state.chainId === "all" ? "active" : ""}`;
  allBtn.innerHTML = `🌐 Todas las redes`;
  allBtn.addEventListener("click", () => {
    if (state.chainId === "all") return;
    state.chainId = "all";
    state.tokenSymbol = "ALL";
    renderChains();
    renderTokens();
    runQuoteSearch();
  });
  el.chainPills.appendChild(allBtn);

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
  el.tokenPills.innerHTML = "";

  if (state.chainId === "all") {
    el.tokenFieldLabel.textContent = "2. Filtrar por activo sintético (en todas las redes)";
    el.contractBar.classList.add("hidden");
    GLOBAL_TOKEN_FILTERS.forEach((sym) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `pill-btn ${sym === state.tokenSymbol ? "active" : ""}`;
      btn.textContent = sym === "ALL" ? "✨ Todos los activos" : sym;
      btn.addEventListener("click", () => {
        if (state.tokenSymbol === sym) return;
        state.tokenSymbol = sym;
        renderTokens();
        runQuoteSearch();
      });
      el.tokenPills.appendChild(btn);
    });
    updateEquivDisplay();
    return;
  }

  el.tokenFieldLabel.textContent = "2. Activo sintético BTC";
  el.contractBar.classList.remove("hidden");
  const chain = CHAINS[state.chainId];
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
  if (state.chainId === "all") {
    el.teleSrcPeg.textContent = "Escáner 7 redes";
    el.teleSrcPeg.className = "tele-value mono pos";
  } else {
    el.teleSrcPeg.textContent = `${state.tokenSymbol} ${fmtPct(t.pegPct)}`;
    el.teleSrcPeg.className = `tele-value mono ${t.pegPct >= 0.05 ? "pos" : t.pegPct <= -0.2 ? "neg" : ""}`;
  }
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
  const { routes, unavailable, scannedPairs } = state.lastResult;
  const isGlobal = state.chainId === "all";

  el.resultsHeading.textContent = isGlobal
    ? `Ranking global en todas las redes (${scannedPairs || 0} pares escaneados)`
    : `Mejores rutas desde ${CHAINS[state.chainId].name} (${state.tokenSymbol})`;

  let filtered = [...routes];
  if (state.filterNoUsd) {
    filtered = filtered.filter((r) => !r.usdExposure);
  }
  if (!state.includeCrossChain) {
    filtered = filtered.filter((r) => !r.crossChainHop);
  }

  if (state.sortBy === "net") {
    filtered.sort((a, b) => b.totalBtcOut - a.totalBtcOut);
  } else if (state.sortBy === "speed") {
    filtered.sort((a, b) => a.etaMinutes - b.etaMinutes || b.totalBtcOut - a.totalBtcOut);
  } else if (state.sortBy === "steps") {
    filtered.sort((a, b) => a.stepsCount - b.stepsCount || b.totalBtcOut - a.totalBtcOut);
  }

  // Cap global view at top 25 routes so UI stays razor-fast
  const displayed = isGlobal ? filtered.slice(0, 25) : filtered;
  el.resultsCount.textContent = isGlobal && filtered.length > 25
    ? `Mostrando Top 25 de ${filtered.length} rutas activas`
    : `${displayed.length} ruta${displayed.length === 1 ? "" : "s"} activa${displayed.length === 1 ? "" : "s"}`;

  // Winner Banner
  if (displayed.length > 0) {
    const best = displayed[0];
    el.winnerBanner.classList.remove("hidden");
    const deltaClass = best.diffPct >= 0 ? "pos" : "neg";
    const originInfo = isGlobal
      ? `Origen ganador: <strong>${best.originChainName} (${best.originToken})</strong> · `
      : "";
    el.winnerBanner.innerHTML = `
      <div>
        <h3>🏆 Mejor opción ahora mismo: ${best.name}</h3>
        <p>${originInfo}${best.model} · Tiempo: <strong>${best.etaLabel}</strong> · ${best.stepsCount} paso${best.stepsCount > 1 ? "s" : ""} · ${best.usdExposure ? "Paso breve por USDC" : "0% exposición a USD"}</p>
      </div>
      <div class="winner-big">
        <div class="winner-btc mono">${best.totalBtcOut.toFixed(6)} BTC</div>
        <div class="winner-diff mono ${deltaClass}">${fmtPct(best.diffPct)} (${best.diffUsd >= 0 ? "+" : ""}${fmtUsd(best.diffUsd)})</div>
      </div>
    `;
  } else {
    el.winnerBanner.classList.add("hidden");
  }

  // Route Cards
  el.routesList.innerHTML = "";
  if (displayed.length === 0) {
    el.routesList.innerHTML = `<div class="panel"><p style="color:var(--text-muted)">No hay rutas activas con los filtros actuales. Prueba desactivando «0% exposición a USD» o activando «Incluir saltos de red».</p></div>`;
  }

  displayed.forEach((r, idx) => {
    const rank = idx + 1;
    const card = document.createElement("article");
    card.className = `route-card ${rank === 1 ? "rank-1" : ""}`;

    const deltaClass = r.diffPct >= -0.05 ? "pos" : r.diffPct >= -0.35 ? "mid" : "bad";
    const originBadgeHtml = isGlobal
      ? `<span class="origin-badge"><span class="chain-dot" style="background:${r.originChainColor}"></span>${r.originChainName} · ${r.originToken}</span>`
      : "";

    const tagsHtml = r.tags
      .map((t) => {
        let cls = "";
        if (t.includes("Salto a ")) cls = "purple";
        else if (t.includes("0% exposición") || t.includes("solo 9 bps") || t.includes("Fee PLANO")) cls = "green";
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
            <div class="route-title">${originBadgeHtml}<span>${r.name}</span></div>
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

  // Unavailable Drawer
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
  el.btnSearchText.textContent = state.chainId === "all" ? "Escaneando 7 redes..." : "Cotizando...";
  el.loadingState.classList.remove("hidden");
  el.loadingDetail.textContent = state.chainId === "all"
    ? "Escaneando en paralelo Arbitrum, Ethereum, Base, Optimism, Avalanche, Polygon y BNB Chain (incluyendo saltos cross-chain a Base y Ethereum)..."
    : "Consultando rutas directas y saltos cross-chain (Across → Base / Ethereum, Garden, Threshold, NEAR Intents, THORChain, Chainflip, Symbiosis y Maya)...";
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

    const result = state.chainId === "all"
      ? await findBestRoutesGlobal({
          tokenFilter: state.tokenSymbol,
          totalAmountBtc,
          tranches: state.tranches,
          telemetry,
        })
      : await findBestRoutes({
          chainId: state.chainId,
          tokenSymbol: state.tokenSymbol,
          totalAmountBtc,
          tranches: state.tranches,
          telemetry,
          includeCrossChainHops: true,
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
      // ignore
    }
  });

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

  el.filterCrossChain.addEventListener("change", () => {
    state.includeCrossChain = el.filterCrossChain.checked;
    renderResults();
  });
}

// Init
renderChains();
renderTokens();
wireEvents();
runQuoteSearch();
