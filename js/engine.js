import { CHAINS, DUMMY_BTC, DUMMY_EVM, DAPP_LINKS } from "./config.js";

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 250) };
    }
    return { ok: res.ok, status: res.status, data: json };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === "AbortError" ? "Timeout" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function toBaseUnits(amountFloat, decimals) {
  // Precision-safe string conversion to integer string
  const fixed = Number(amountFloat).toFixed(Math.min(decimals, 8));
  const [intPart, fracPart = ""] = fixed.split(".");
  const padded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const combined = (intPart + padded).replace(/^0+/, "") || "0";
  return combined;
}

export function fromBaseUnits(rawStr, decimals) {
  if (!rawStr) return 0;
  const s = String(rawStr).padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  return parseFloat(`${intPart}.${fracPart}`);
}

/**
 * Fetch live reference prices (BTC spot + selected token) and Bitcoin mempool fees
 */
export async function fetchTelemetry(chainId, tokenSymbol) {
  const chain = CHAINS[chainId];
  const token = chain.tokens[tokenSymbol];
  const llamaKey = `${chain.llamaPrefix}:${token.address}`;

  const [priceRes, mempoolRes] = await Promise.all([
    fetchJson(`https://coins.llama.fi/prices/current/coingecko:bitcoin,${llamaKey}`),
    fetchJson("https://mempool.space/api/v1/fees/recommended"),
  ]);

  const coins = priceRes.ok ? priceRes.data?.coins || {} : {};
  const btcPrice = coins["coingecko:bitcoin"]?.price || 0;
  const tokenPrice = coins[llamaKey]?.price || btcPrice;
  const pegPct = btcPrice > 0 ? ((tokenPrice / btcPrice) - 1) * 100 : 0;

  const mempool = mempoolRes.ok
    ? mempoolRes.data
    : { fastestFee: 2, halfHourFee: 2, economyFee: 1 };

  // Estimate standard SegWit (140 vB) tx fee in BTC
  const estBtcTxFeeBtc = ((mempool.halfHourFee || 2) * 140) / 1e8;

  return {
    btcPrice,
    tokenPrice,
    pegPct,
    mempool,
    estBtcTxFeeBtc,
    timestamp: new Date(),
  };
}

/**
 * KyberSwap DEX Aggregator quote on a single EVM chain
 */
async function quoteKyberSwap(kyberSlug, tokenInAddr, tokenOutAddr, amountInRaw, decimalsOut) {
  const url = `https://aggregator-api.kyberswap.com/${kyberSlug}/api/v1/routes?tokenIn=${tokenInAddr}&tokenOut=${tokenOutAddr}&amountIn=${amountInRaw}`;
  const res = await fetchJson(url);
  if (!res.ok || !res.data?.data?.routeSummary?.amountOut) {
    return { ok: false, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  const rs = res.data.data.routeSummary;
  return {
    ok: true,
    amountOutRaw: rs.amountOut,
    amountOut: fromBaseUnits(rs.amountOut, decimalsOut),
    amountInUsd: parseFloat(rs.amountInUsd || "0"),
    amountOutUsd: parseFloat(rs.amountOutUsd || "0"),
  };
}

/**
 * Garden Finance v2 quote
 */
async function quoteGarden(fromId, amountRaw) {
  const url = `https://api.garden.finance/v2/quote?from=${encodeURIComponent(fromId)}&to=bitcoin:btc&from_amount=${amountRaw}`;
  const res = await fetchJson(url);
  if (!res.ok || res.data?.status !== "Ok" || !res.data?.result?.length) {
    return { ok: false, error: res.data?.error || res.error || `HTTP ${res.status}` };
  }
  const best = res.data.result[0];
  return {
    ok: true,
    btcOut: fromBaseUnits(best.destination.amount, 8),
    feeBps: best.fee,
    solver: best.solver_id || "garden-solver",
  };
}

/**
 * Across bridge suggested-fees quote (USDC origin -> Base)
 */
async function quoteAcrossUsdcToBase(originChain, usdcAmountRaw) {
  const baseUsdc = CHAINS.base.usdc.address;
  const url = `https://app.across.to/api/suggested-fees?inputToken=${originChain.usdc.address}&outputToken=${baseUsdc}&originChainId=${originChain.chainId}&destinationChainId=8453&amount=${usdcAmountRaw}`;
  const res = await fetchJson(url);
  if (!res.ok || !res.data?.totalRelayFee?.total) {
    return { ok: false, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  const totalFeeRaw = BigInt(res.data.totalRelayFee.total);
  const inRaw = BigInt(usdcAmountRaw);
  if (inRaw <= totalFeeRaw) return { ok: false, error: "Importe menor que el fee de bridge" };
  const netOriginDecimals = inRaw - totalFeeRaw;
  // Convert to Base USDC (6 decimals)
  const diffDec = originChain.usdc.decimals - 6;
  const netBaseRaw = diffDec > 0
    ? (netOriginDecimals / (10n ** BigInt(diffDec))).toString()
    : (netOriginDecimals * (10n ** BigInt(-diffDec))).toString();

  return {
    ok: true,
    feeUsdc: fromBaseUnits(totalFeeRaw.toString(), originChain.usdc.decimals),
    netBaseUsdcRaw: netBaseRaw,
    netBaseUsdc: fromBaseUnits(netBaseRaw, 6),
    estFillSec: res.data.estimatedFillTimeSec || 2,
  };
}

/**
 * NEAR Intents 1Click dry quote
 */
async function quoteNearIntents(originAssetId, amountRaw) {
  const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const payload = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: originAssetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:btc.omft.near",
    amount: String(amountRaw),
    refundTo: DUMMY_EVM,
    refundType: "ORIGIN_CHAIN",
    recipient: DUMMY_BTC,
    recipientType: "DESTINATION_CHAIN",
    deadline,
  };
  const res = await fetchJson("https://1click.chaindefuser.com/v0/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.data?.quote?.amountOut) {
    return { ok: false, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  const q = res.data.quote;
  const rawBtcOut = fromBaseUnits(q.amountOut, 8);
  // Note: Unauthenticated 1Click API adds 25 bps (0.25%) platform fee that official app.near-intents.org UI doesn't charge
  const estUiBtcOut = rawBtcOut / (1 - 0.0025);
  return {
    ok: true,
    rawBtcOut,
    estUiBtcOut,
    timeSec: q.timeEstimate || 600,
  };
}

/**
 * Symbiosis direct EVM -> Bitcoin quote
 */
async function quoteSymbiosis(chainIdNum, tokenAddr, decimals, amountRaw) {
  const payload = {
    tokenAmountIn: {
      address: tokenAddr,
      chainId: chainIdNum,
      decimals,
      amount: String(amountRaw),
    },
    tokenOut: {
      address: "",
      chainId: 3652501241, // Bitcoin on Symbiosis
      decimals: 8,
    },
    from: DUMMY_EVM,
    to: DUMMY_BTC,
    slippage: 100,
  };
  const res = await fetchJson("https://api.symbiosis.finance/crosschain/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.data?.tokenAmountOut?.amount) {
    return { ok: false, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  return {
    ok: true,
    btcOut: fromBaseUnits(res.data.tokenAmountOut.amount, 8),
    priceImpact: res.data.priceImpact,
  };
}

/**
 * THORChain Mimir + Streaming Swap Quote
 */
async function fetchThorMimir() {
  const res = await fetchJson("https://gateway.liquify.com/chain/thorchain_api/thorchain/mimir", {
    headers: { "x-client-id": "btc-route-finder" },
  });
  if (!res.ok || !res.data) return { ok: false, error: res.error || `HTTP ${res.status}` };
  return { ok: true, mimir: res.data };
}

async function quoteThorChain(fromAsset, amount1e8) {
  const url = `https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap?from_asset=${encodeURIComponent(fromAsset)}&to_asset=BTC.BTC&amount=${amount1e8}&destination=${DUMMY_BTC}&streaming_interval=1&streaming_quantity=0`;
  const res = await fetchJson(url, { headers: { "x-client-id": "btc-route-finder" } });
  if (!res.ok || !res.data?.expected_amount_out) {
    return { ok: false, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  return {
    ok: true,
    btcOut: fromBaseUnits(res.data.expected_amount_out, 8),
    totalBps: res.data.fees?.total_bps,
    timeSec: res.data.total_swap_seconds || 900,
  };
}

/**
 * Chainflip v2 Quote
 */
async function quoteChainflip(srcChain, srcAsset, amountRaw) {
  const url = `https://chainflip-swap.chainflip.io/v2/quote?srcChain=${srcChain}&srcAsset=${srcAsset}&destChain=Bitcoin&destAsset=BTC&amount=${amountRaw}&isVaultSwap=true`;
  const res = await fetchJson(url);
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) {
    return { ok: false, status: res.status, error: res.data?.message || res.error || `HTTP ${res.status}` };
  }
  // Prefer DCA quote if available and gives more BTC
  const sorted = [...res.data].sort((a, b) => Number(b.egressAmount || 0) - Number(a.egressAmount || 0));
  const best = sorted[0];
  return {
    ok: true,
    btcOut: fromBaseUnits(best.egressAmount, 8),
    type: best.type,
    timeSec: best.estimatedDurationSeconds || 900,
  };
}

/**
 * Maya Protocol Quote
 */
async function quoteMaya(fromAsset, amount1e8) {
  const url = `https://mayanode.mayachain.info/mayachain/quote/swap?from_asset=${encodeURIComponent(fromAsset)}&to_asset=BTC.BTC&amount=${amount1e8}&destination=${DUMMY_BTC}&streaming_interval=1&streaming_quantity=0`;
  const res = await fetchJson(url);
  if (!res.ok || !res.data?.expected_amount_out || res.data?.error) {
    return { ok: false, error: res.data?.error || res.error || `HTTP ${res.status}` };
  }
  return {
    ok: true,
    btcOut: fromBaseUnits(res.data.expected_amount_out, 8),
    timeSec: res.data.total_swap_seconds || 1200,
  };
}

/**
 * Master route discovery engine:
 * Runs ALL viable No-KYC routes in parallel for (chainId, tokenSymbol, amountBtcPerTx, tranches)
 */
export async function findBestRoutes({ chainId, tokenSymbol, totalAmountBtc, tranches = 1, telemetry }) {
  const chain = CHAINS[chainId];
  const token = chain.tokens[tokenSymbol];
  const amountPerTx = totalAmountBtc / tranches;
  const amountRaw = toBaseUnits(amountPerTx, token.decimals);

  const routes = [];
  const unavailable = [];
  const protocolHealth = {
    Garden: { state: "unknown", label: "Garden" },
    Threshold: { state: "ok", label: "Threshold tBTC" },
    NEAR: { state: "unknown", label: "NEAR Intents" },
    THORChain: { state: "unknown", label: "THORChain" },
    Chainflip: { state: "unknown", label: "Chainflip" },
    Symbiosis: { state: "unknown", label: "Symbiosis" },
  };

  // Pre-fetch shared intermediate DEX swaps on origin chain (to USDC, to tBTC, to Garden-native token if different, to BTC.b on Avax)
  const dexPromises = {};

  // 1) Origin -> USDC on origin chain (needed for Base+Garden, NEAR Intents, Chainflip, THORChain)
  dexPromises.toUsdc = quoteKyberSwap(chain.kyberSlug, token.address, chain.usdc.address, amountRaw, chain.usdc.decimals);

  // 2) Origin -> tBTC on origin chain (if chain supports Threshold direct redeem and token isn't already tBTC)
  const chainTbtc = Object.values(chain.tokens).find((t) => t.isTbtc);
  if (chain.thresholdDirectRedeem && chainTbtc && !token.isTbtc) {
    dexPromises.toTbtc = quoteKyberSwap(chain.kyberSlug, token.address, chainTbtc.address, amountRaw, chainTbtc.decimals);
  }

  // 3) Origin -> chain's native Garden BTC asset (if token itself isn't Garden-native, e.g., Arb cbBTC -> Arb WBTC)
  const chainGardenToken = Object.values(chain.tokens).find((t) => t.gardenId);
  if (chainGardenToken && !token.gardenId) {
    dexPromises.toGardenToken = quoteKyberSwap(chain.kyberSlug, token.address, chainGardenToken.address, amountRaw, chainGardenToken.decimals);
  }

  // 4) Avalanche WBTC.e -> BTC.b
  const chainBtcb = Object.values(chain.tokens).find((t) => t.isBtcb);
  if (chainId === "avalanche" && chainBtcb && !token.isBtcb) {
    dexPromises.toBtcb = quoteKyberSwap(chain.kyberSlug, token.address, chainBtcb.address, amountRaw, chainBtcb.decimals);
  }

  // Also kick off THORChain Mimir check in parallel
  const mimirPromise = fetchThorMimir();

  const [usdcDex, tbtcDex, gardenTokenDex, btcbDex, mimirRes] = await Promise.all([
    dexPromises.toUsdc,
    dexPromises.toTbtc || Promise.resolve(null),
    dexPromises.toGardenToken || Promise.resolve(null),
    dexPromises.toBtcb || Promise.resolve(null),
    mimirPromise,
  ]);

  // Helper to record a valid route
  const addRoute = (r) => {
    const totalBtcOut = r.btcOutPerTx * tranches;
    const diffPct = ((totalBtcOut / totalAmountBtc) - 1) * 100;
    const diffUsd = (totalBtcOut - totalAmountBtc) * (telemetry.btcPrice || 0);
    routes.push({
      ...r,
      totalBtcOut,
      diffPct,
      diffUsd,
      tranches,
    });
  };

  // Launch ALL cross-chain route evaluations in parallel
  const tasks = [];

  // =========================================================================
  // ROUTE 1: GARDEN FINANCE DIRECT (or 1 same-chain swap -> Garden)
  // =========================================================================
  if (token.gardenId) {
    tasks.push((async () => {
      const q = await quoteGarden(token.gardenId, amountRaw);
      if (q.ok) {
        protocolHealth.Garden = { state: "ok", label: `Garden (${q.feeBps ?? "?"} bps)` };
        addRoute({
          id: "garden-direct",
          name: `Garden Finance Directo (${chain.name} ${token.symbol})`,
          protocol: "Garden Finance",
          model: "HTLC Atomic Swap",
          btcOutPerTx: q.btcOut,
          etaMinutes: 10,
          etaLabel: "~5–15 min",
          stepsCount: 1,
          usdExposure: false,
          tags: ["1 solo clic", "HTLC sin custodia", `Fee ${q.feeBps ?? "?"} bps`, "0% exposición USD"],
          note: "Swap atómico criptográfico (HTLC) sin custodios ni saltos de red. Ideal por simplicidad y velocidad.",
          steps: [
            {
              text: `Conecta tu wallet en ${chain.name} y selecciona ${token.symbol} → BTC nativo (pega tu dirección bc1q.../bc1p...).`,
              linkLabel: "Abrir Garden Finance",
              linkUrl: DAPP_LINKS.garden,
            },
          ],
        });
      } else {
        protocolHealth.Garden = { state: "down", label: "Garden (error)" };
        unavailable.push({ name: "Garden Finance Directo", reason: q.error });
      }
    })());
  } else if (chainGardenToken && gardenTokenDex?.ok) {
    tasks.push((async () => {
      const q = await quoteGarden(chainGardenToken.gardenId, gardenTokenDex.amountOutRaw);
      if (q.ok) {
        protocolHealth.Garden = { state: "ok", label: `Garden (${q.feeBps ?? "?"} bps)` };
        addRoute({
          id: "garden-swap",
          name: `DEX (${token.symbol} → ${chainGardenToken.symbol}) → Garden Finance`,
          protocol: "Garden Finance",
          model: "DEX + HTLC",
          btcOutPerTx: q.btcOut,
          etaMinutes: 12,
          etaLabel: "~8–15 min",
          stepsCount: 2,
          usdExposure: false,
          tags: ["HTLC sin custodia", `Fee ${q.feeBps ?? "?"} bps`, "0% exposición USD"],
          note: `Swap previo ${token.symbol} → ${chainGardenToken.symbol} en ${chain.name} (${gardenTokenDex.amountOut.toFixed(6)} ${chainGardenToken.symbol}) y salida directa HTLC por Garden.`,
          steps: [
            {
              text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ${chainGardenToken.symbol} en ${chain.name} (CoW Swap / DefiLlama).`,
              linkLabel: "Abrir DefiLlama Swap",
              linkUrl: DAPP_LINKS.defiLlamaSwap,
            },
            {
              text: `Envía ${chainGardenToken.symbol} (${chain.name}) → BTC nativo en Garden Finance.`,
              linkLabel: "Abrir Garden Finance",
              linkUrl: DAPP_LINKS.garden,
            },
          ],
        });
      } else {
        unavailable.push({ name: "Garden Finance (vía swap local)", reason: q.error });
      }
    })());
  }

  // =========================================================================
  // ROUTE 2: GARDEN "9-BPS BASE HACK" (Any Across-supported chain -> Base cbBTC -> Garden)
  // =========================================================================
  if (chainId !== "base" && chain.acrossSupported && usdcDex?.ok) {
    tasks.push((async () => {
      const across = await quoteAcrossUsdcToBase(chain, usdcDex.amountOutRaw);
      if (!across.ok) {
        unavailable.push({ name: "Base cbBTC + Garden (9 bps)", reason: `Across: ${across.error}` });
        return;
      }
      const baseSwap = await quoteKyberSwap(
        "base",
        CHAINS.base.usdc.address,
        CHAINS.base.tokens.cbBTC.address,
        across.netBaseUsdcRaw,
        8
      );
      if (!baseSwap.ok) {
        unavailable.push({ name: "Base cbBTC + Garden (9 bps)", reason: `DEX Base: ${baseSwap.error}` });
        return;
      }
      const g = await quoteGarden("base:cbbtc", baseSwap.amountOutRaw);
      if (!g.ok) {
        unavailable.push({ name: "Base cbBTC + Garden (9 bps)", reason: `Garden Base: ${g.error}` });
        return;
      }
      if (protocolHealth.Garden.state === "unknown") {
        protocolHealth.Garden = { state: "ok", label: `Garden (${g.feeBps} bps Base)` };
      }
      addRoute({
        id: "base-cbbtc-garden",
        name: `Across a Base → cbBTC → Garden Finance (${g.feeBps ?? 9} bps)`,
        protocol: "Across + Garden (Base)",
        model: "Intent Bridge + HTLC",
        btcOutPerTx: g.btcOut,
        etaMinutes: 14,
        etaLabel: "~10–15 min",
        stepsCount: 4,
        usdExposure: true,
        tags: [`Garden solo ${g.feeBps ?? 9} bps`, `Across ${across.estFillSec}s ($${across.feeUsdc.toFixed(2)})`, "HTLC sin custodia"],
        note: `Aprovecha que Garden cobra ~la mitad en Base cbBTC (${g.feeBps ?? 9} bps). Necesitas ~$1 de ETH en Base para gas. Breve exposición a USDC (~1 min).`,
        steps: [
          {
            text: `En ${chain.name}, cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${usdcDex.amountOut.toFixed(2)} USDC.`,
            linkLabel: "Abrir CoW / DefiLlama",
            linkUrl: DAPP_LINKS.defiLlamaSwap,
          },
          {
            text: `Puentea USDC de ${chain.name} → Base vía Across (~${across.estFillSec}s, fee $${across.feeUsdc.toFixed(2)}).`,
            linkLabel: "Abrir Across",
            linkUrl: DAPP_LINKS.across,
          },
          {
            text: `En Base, cambia ~${across.netBaseUsdc.toFixed(2)} USDC → ~${baseSwap.amountOut.toFixed(6)} cbBTC.`,
            linkLabel: "Abrir KyberSwap Base",
            linkUrl: DAPP_LINKS.kyberSwap,
          },
          {
            text: `En Garden Finance selecciona Base cbBTC → Bitcoin BTC (${g.feeBps ?? 9} bps) hacia tu bc1q.../bc1p...`,
            linkLabel: "Abrir Garden Finance",
            linkUrl: DAPP_LINKS.garden,
          },
        ],
      });
    })());
  }

  // =========================================================================
  // ROUTE 3: THRESHOLD NETWORK tBTC DIRECT REDEMPTION (0.20% protocol fee + BTC miner fee)
  // =========================================================================
  if (chain.thresholdDirectRedeem && chainTbtc) {
    tasks.push((async () => {
      let tbtcAmount = amountPerTx;
      let dexNote = "Ya tienes tBTC: 0% slippage DEX.";
      let steps = [];

      if (!token.isTbtc) {
        if (!tbtcDex?.ok) {
          unavailable.push({ name: "Threshold Network (tBTC)", reason: `Swap a tBTC falló: ${tbtcDex?.error}` });
          return;
        }
        tbtcAmount = tbtcDex.amountOut;
        const dexRatioPct = ((tbtcAmount / amountPerTx) - 1) * 100;
        dexNote = `Swap ${token.symbol} → tBTC en ${chain.name}: ${dexRatioPct >= 0 ? "+" : ""}${dexRatioPct.toFixed(3)}% (${tbtcAmount.toFixed(6)} tBTC).`;
        steps.push({
          text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${tbtcAmount.toFixed(6)} tBTC en ${chain.name} (verifica contrato ${chainTbtc.address.slice(0, 10)}...).`,
          linkLabel: "Abrir CoW Swap",
          linkUrl: DAPP_LINKS.cowSwap,
        });
      }

      if (tbtcAmount < 0.01) {
        unavailable.push({
          name: "Threshold Network (tBTC Redeem)",
          reason: `Importe por tramo (${tbtcAmount.toFixed(5)} BTC) inferior al mínimo de redención (~0.01 BTC).`,
        });
        return;
      }

      // Threshold protocol fee: 0.20% + live Bitcoin network sweep fee (estimate ~2x standard tx for threshold sweep)
      const protocolFeeBtc = tbtcAmount * 0.002;
      const estMinerSweepBtc = Math.max(telemetry.estBtcTxFeeBtc * 2.5, 0.000008);
      const netBtc = tbtcAmount - protocolFeeBtc - estMinerSweepBtc;

      steps.push({
        text: `En Threshold Network (red ${chain.name}), entra en Redeem/Unmint, verifica el neto exacto (0,20% protocolo + fee red BTC) y pega tu dirección bc1q.../bc1p...`,
        linkLabel: "Abrir Threshold App",
        linkUrl: DAPP_LINKS.threshold,
      });

      addRoute({
        id: "threshold-tbtc",
        name: token.isTbtc
          ? `Threshold Network Redeem Directo (${chain.name} tBTC)`
          : `DEX (${token.symbol} → tBTC) → Threshold Network Redeem`,
        protocol: "Threshold Network",
        model: "Descentralizado 1:1 (Burn & Release)",
        btcOutPerTx: netBtc,
        etaMinutes: 180,
        etaLabel: "~1–5 horas",
        stepsCount: token.isTbtc ? 1 : 2,
        usdExposure: false,
        tags: ["Fee protocolo 0,20%", "0% slippage AMM en BTC", "0% exposición USD", "Mín. 0,01 BTC"],
        note: `${dexNote} Respaldo 1:1 descentralizado (>4.000 BTC). Comprueba en la UI de Threshold el neto exacto (posible pequeño fee de relayer L2) antes de hacer el swap.`,
        warnNote: "Tarda 1–5 horas; comprueba en app.threshold.network que las redenciones estén activas antes de convertir a tBTC.",
        steps,
      });
    })());
  }

  // =========================================================================
  // ROUTE 4: NEAR INTENTS (1Click Solver Network — Direct or via USDC)
  // =========================================================================
  if (token.nearDirectId || (chain.nearUsdcId && usdcDex?.ok)) {
    tasks.push((async () => {
      const isDirect = Boolean(token.nearDirectId);
      const nearAsset = isDirect ? token.nearDirectId : chain.nearUsdcId;
      const nearAmt = isDirect ? amountRaw : usdcDex.amountOutRaw;
      const q = await quoteNearIntents(nearAsset, nearAmt);
      if (q.ok) {
        protocolHealth.NEAR = { state: "ok", label: "NEAR Intents" };
        const steps = [];
        if (!isDirect) {
          steps.push({
            text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${usdcDex.amountOut.toFixed(2)} USDC en ${chain.name}.`,
            linkLabel: "Abrir CoW / DefiLlama",
            linkUrl: DAPP_LINKS.defiLlamaSwap,
          });
        }
        steps.push({
          text: `En NEAR Intents selecciona ${isDirect ? token.symbol : "USDC"} (${chain.name}) → BTC nativo y compara el neto oficial en pantalla.`,
          linkLabel: "Abrir NEAR Intents",
          linkUrl: DAPP_LINKS.nearIntents,
        });

        addRoute({
          id: "near-intents",
          name: isDirect
            ? `NEAR Intents Directo (${chain.name} ${token.symbol})`
            : `DEX (${token.symbol} → USDC) → NEAR Intents`,
          protocol: "NEAR Intents",
          model: "Solver Intents",
          // Show conservative raw API quote as primary, and note the +0.25% better expected UI quote
          btcOutPerTx: q.rawBtcOut,
          etaMinutes: Math.max(5, Math.round(q.timeSec / 60)),
          etaLabel: `~${Math.max(5, Math.round(q.timeSec / 60))} min`,
          stepsCount: isDirect ? 1 : 2,
          usdExposure: !isDirect,
          tags: [
            "Red de Solvers",
            isDirect ? "1 paso · 0% USD" : "Vía USDC",
            `UI oficial est. ~${(q.estUiBtcOut * tranches).toFixed(6)} BTC`,
          ],
          note: `La API pública sin clave añade +0,25% de margen (conservador: ${(q.rawBtcOut * tranches).toFixed(6)} BTC). En la UI oficial (app.near-intents.org) suele mejorar hasta ~${(q.estUiBtcOut * tranches).toFixed(6)} BTC.`,
          steps,
        });
      } else {
        protocolHealth.NEAR = { state: "warn", label: "NEAR Intents (parcial)" };
        unavailable.push({ name: "NEAR Intents (1Click)", reason: q.error });
      }
    })());
  }

  // =========================================================================
  // ROUTE 5: SYMBIOSIS DIRECT (EVM -> Native BTC)
  // =========================================================================
  tasks.push((async () => {
    const q = await quoteSymbiosis(chain.chainId, token.address, token.decimals, amountRaw);
    if (q.ok) {
      protocolHealth.Symbiosis = { state: "ok", label: "Symbiosis" };
      addRoute({
        id: "symbiosis-direct",
        name: `Symbiosis Finance Directo (${chain.name} ${token.symbol})`,
        protocol: "Symbiosis",
        model: "Cross-Chain AMM Bridge",
        btcOutPerTx: q.btcOut,
        etaMinutes: 20,
        etaLabel: "~15–30 min",
        stepsCount: 1,
        usdExposure: false,
        tags: ["1 solo paso", "0% exposición USD", "Sin KYC"],
        note: "Puente directo en 1 firma desde tu wallet EVM pegando tu dirección bc1q.../bc1p...",
        steps: [
          {
            text: `En Symbiosis selecciona ${token.symbol} (${chain.name}) → Bitcoin (BTC) e introduce tu dirección destino.`,
            linkLabel: "Abrir Symbiosis",
            linkUrl: DAPP_LINKS.symbiosis,
          },
        ],
      });
    } else {
      protocolHealth.Symbiosis = { state: "warn", label: "Symbiosis (límite/err)" };
      unavailable.push({ name: "Symbiosis Finance Directo", reason: q.error });
    }
  })());

  // =========================================================================
  // ROUTE 6: LOMBARD / CORE (BTC.b 0.0001 BTC flat fee, or LBTC unstake)
  // =========================================================================
  if (chainId === "avalanche" || token.isBtcb) {
    tasks.push((async () => {
      let btcbAmt = amountPerTx;
      const steps = [];
      if (!token.isBtcb) {
        if (!btcbDex?.ok) {
          unavailable.push({ name: "Lombard / Core (BTC.b)", reason: btcbDex?.error || "Sin liquidez" });
          return;
        }
        btcbAmt = btcbDex.amountOut;
        steps.push({
          text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${btcbAmt.toFixed(6)} BTC.b en ${chain.name}.`,
          linkLabel: "Abrir DefiLlama Swap",
          linkUrl: DAPP_LINKS.defiLlamaSwap,
        });
      }
      const flatFee = 0.0001;
      if (btcbAmt <= flatFee * 2) {
        unavailable.push({ name: "Lombard / Core (BTC.b)", reason: "Importe demasiado pequeño para el fee fijo de 0.0001 BTC." });
        return;
      }
      const netBtc = btcbAmt - flatFee;
      steps.push({
        text: `Redime BTC.b → BTC nativo (redeemForBTC) en Lombard / Core. Comisión plana fija: 0.0001 BTC (~2 horas).`,
        linkLabel: "Abrir Lombard App",
        linkUrl: DAPP_LINKS.lombard,
      });
      addRoute({
        id: "lombard-btcb",
        name: `Lombard / Core Redeem (${chain.name} BTC.b — 0.0001 BTC fijo)`,
        protocol: "Lombard / BTC.b",
        model: "Redención Fee Fijo",
        btcOutPerTx: netBtc,
        etaMinutes: 120,
        etaLabel: "~2 horas",
        stepsCount: token.isBtcb ? 1 : 2,
        usdExposure: false,
        tags: ["Fee PLANO 0.0001 BTC", "Sin % de comisión", "0% exposición USD"],
        note: "Comisión fija de 0.0001 BTC independientemente del importe. Imbatible para importes grandes (≥0.5–1 BTC) en un solo tramo.",
        steps,
      });
    })());
  }

  if (token.isLbtc) {
    tasks.push((async () => {
      const flatFee = 0.0001;
      if (amountPerTx > flatFee * 2) {
        addRoute({
          id: "lombard-lbtc",
          name: `Lombard Unstake Nativo (${chain.name} LBTC → BTC)`,
          protocol: "Lombard Finance",
          model: "Unstake Nativo (7–9 días)",
          btcOutPerTx: amountPerTx - flatFee,
          etaMinutes: 10080,
          etaLabel: "~7–9 días",
          stepsCount: 1,
          usdExposure: false,
          tags: ["Fee PLANO 0.0001 BTC", "0% slippage", "Espera larga"],
          note: "Unstake directo de LBTC a BTC nativo por 0.0001 BTC fijo, pero requiere esperar ~7–9 días de desbloqueo.",
          steps: [
            {
              text: `En Lombard Finance solicita Unstake de ${amountPerTx.toFixed(6)} LBTC hacia tu dirección Bitcoin nativa.`,
              linkLabel: "Abrir Lombard App",
              linkUrl: DAPP_LINKS.lombard,
            },
          ],
        });
      }
    })());
  }

  // =========================================================================
  // ROUTE 7: THORCHAIN STREAMING SWAPS (with live Mimir halt detection)
  // =========================================================================
  tasks.push((async () => {
    if (!mimirRes.ok) {
      protocolHealth.THORChain = { state: "down", label: "THORChain (API err)" };
      unavailable.push({ name: "THORChain Streaming", reason: mimirRes.error });
      return;
    }
    const m = mimirRes.mimir;
    const btcHalted = Number(m.HALTBTCTRADING || 0) !== 0 || Number(m.HALTTRADING || 0) !== 0;
    const baseHalted = Number(m.HALTBASETRADING || 0) !== 0;

    if (btcHalted) {
      protocolHealth.THORChain = { state: "down", label: "THORChain (BTC PAUSADO)" };
      unavailable.push({
        name: "THORChain Streaming Swaps",
        reason: "Trading de BTC pausado actualmente en THORChain (Mimir HALTBTCTRADING=1).",
      });
      return;
    }

    let thorAsset = token.thorAsset;
    let thorAmt1e8 = toBaseUnits(amountPerTx, 8);
    let viaUsdc = false;

    if (!thorAsset && chain.thorUsdcAsset && usdcDex?.ok) {
      if (chainId === "base" && baseHalted) {
        protocolHealth.THORChain = { state: "warn", label: "THORChain (Base pausado)" };
        unavailable.push({ name: "THORChain (Base USDC)", reason: "HALTBASETRADING=1 activo." });
        return;
      }
      thorAsset = chain.thorUsdcAsset;
      thorAmt1e8 = toBaseUnits(usdcDex.amountOut, 8);
      viaUsdc = true;
    }

    if (!thorAsset) {
      protocolHealth.THORChain = { state: "ok", label: "THORChain (L1/Base/BSC)" };
      return;
    }

    const q = await quoteThorChain(thorAsset, thorAmt1e8);
    if (q.ok) {
      protocolHealth.THORChain = { state: "ok", label: "THORChain" };
      const steps = [];
      if (viaUsdc) {
        steps.push({
          text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${usdcDex.amountOut.toFixed(2)} USDC en ${chain.name}.`,
          linkLabel: "Abrir DefiLlama Swap",
          linkUrl: DAPP_LINKS.defiLlamaSwap,
        });
      }
      steps.push({
        text: `Ejecuta Streaming Swap de ${viaUsdc ? "USDC" : token.symbol} → BTC nativo en THORChain (usa Asgardex o frontend con 0% affiliate fee).`,
        linkLabel: "Abrir THORSwap",
        linkUrl: DAPP_LINKS.thorSwap,
      });
      addRoute({
        id: "thorchain-streaming",
        name: viaUsdc
          ? `DEX (${token.symbol} → USDC) → THORChain Streaming`
          : `THORChain Streaming Directo (${chain.name} ${token.symbol})`,
        protocol: "THORChain",
        model: "Streaming Swaps (Vaults)",
        btcOutPerTx: q.btcOut,
        etaMinutes: Math.max(10, Math.round(q.timeSec / 60)),
        etaLabel: `~${Math.max(10, Math.round(q.timeSec / 60))} min`,
        stepsCount: viaUsdc ? 2 : 1,
        usdExposure: viaUsdc,
        tags: ["Streaming Swaps", "Alta liquidez", "Sin KYC"],
        note: "Divide el swap entre bloques automáticamente para reducir slippage. Revisa que el frontend elegido no sume affiliate fee excesivo.",
        steps,
      });
    } else {
      protocolHealth.THORChain = { state: "warn", label: "THORChain (pausado/err)" };
      unavailable.push({ name: "THORChain Streaming Swaps", reason: q.error });
    }
  })());

  // =========================================================================
  // ROUTE 8: CHAINFLIP (JIT AMM + DCA)
  // =========================================================================
  if (token.chainflipAsset || (chainId === "arbitrum" && usdcDex?.ok)) {
    tasks.push((async () => {
      const isDirect = Boolean(token.chainflipAsset);
      const cfChain = isDirect ? token.chainflipAsset.chain : "Arbitrum";
      const cfAsset = isDirect ? token.chainflipAsset.asset : "USDC";
      const cfAmt = isDirect ? amountRaw : usdcDex.amountOutRaw;

      const q = await quoteChainflip(cfChain, cfAsset, cfAmt);
      if (q.ok) {
        protocolHealth.Chainflip = { state: "ok", label: "Chainflip" };
        const steps = [];
        if (!isDirect) {
          steps.push({
            text: `Cambia ${amountPerTx.toFixed(6)} ${token.symbol} → ~${usdcDex.amountOut.toFixed(2)} USDC en Arbitrum.`,
            linkLabel: "Abrir CoW / DefiLlama",
            linkUrl: DAPP_LINKS.defiLlamaSwap,
          });
        }
        steps.push({
          text: `Ejecuta swap ${q.type === "DCA" ? "DCA / Streaming" : "Directo"} de ${cfAsset} (${cfChain}) → BTC nativo en Chainflip.`,
          linkLabel: "Abrir Chainflip",
          linkUrl: DAPP_LINKS.chainflip,
        });
        addRoute({
          id: "chainflip",
          name: isDirect
            ? `Chainflip ${q.type || "JIT"} Directo (${cfChain} ${cfAsset})`
            : `DEX (${token.symbol} → USDC) → Chainflip ${q.type || "DCA"}`,
          protocol: "Chainflip",
          model: "JIT AMM + DCA",
          btcOutPerTx: q.btcOut,
          etaMinutes: Math.max(8, Math.round(q.timeSec / 60)),
          etaLabel: `~${Math.max(8, Math.round(q.timeSec / 60))} min`,
          stepsCount: isDirect ? 1 : 2,
          usdExposure: !isDirect,
          tags: ["JIT AMM (~0,10–0,15%)", q.type === "DCA" ? "DCA anti-slippage" : "Vault Swap", "Sin KYC"],
          note: "AMM Just-in-Time con baja comisión y soporte nativo de DCA para importes medianos/grandes.",
          steps,
        });
      } else {
        const isMaint = q.status === 503;
        protocolHealth.Chainflip = {
          state: isMaint ? "warn" : "down",
          label: isMaint ? "Chainflip (mantenimiento)" : "Chainflip (err)",
        };
        unavailable.push({
          name: "Chainflip (JIT AMM + DCA)",
          reason: isMaint ? "API de cotización en mantenimiento temporal (HTTP 503)." : q.error,
        });
      }
    })());
  } else {
    protocolHealth.Chainflip = { state: "ok", label: "Chainflip (ETH/Arb)" };
  }

  // =========================================================================
  // ROUTE 9: MAYA PROTOCOL (Arbitrum / Ethereum direct WBTC check)
  // =========================================================================
  if (token.mayaAsset) {
    tasks.push((async () => {
      const q = await quoteMaya(token.mayaAsset, toBaseUnits(amountPerTx, 8));
      if (q.ok) {
        addRoute({
          id: "maya-direct",
          name: `Maya Protocol Directo (${chain.name} ${token.symbol})`,
          protocol: "Maya Protocol",
          model: "Continuous Liquidity Pool",
          btcOutPerTx: q.btcOut,
          etaMinutes: 20,
          etaLabel: "~15–25 min",
          stepsCount: 1,
          usdExposure: false,
          tags: ["1 paso", "0% exposición USD", "Revisar profundidad"],
          note: "Pool CLP descentralizado. En Arbitrum la profundidad suele ser baja: compara siempre el % neto frente a Garden y Threshold.",
          steps: [
            {
              text: `Ejecuta swap ${token.symbol} (${chain.name}) → BTC nativo vía Maya Protocol / SwapKit.`,
              linkLabel: "Abrir Maya Protocol",
              linkUrl: DAPP_LINKS.maya,
            },
          ],
        });
      } else {
        unavailable.push({
          name: `Maya Protocol (${chain.name} ${token.symbol})`,
          reason: `Sin liquidez suficiente o error de simulación (${String(q.error).slice(0, 90)}).`,
        });
      }
    })());
  }

  await Promise.all(tasks);

  // Default sort: highest net BTC first
  routes.sort((a, b) => b.totalBtcOut - a.totalBtcOut);

  return {
    routes,
    unavailable,
    protocolHealth,
  };
}
