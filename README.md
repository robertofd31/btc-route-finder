# ₿ BTC Route Finder — Comparador DeFi en Vivo (100% No-KYC)

Panel web estático y gratuito (sin backend ni claves de API) para encontrar en **1 clic** la mejor ruta **100% No-KYC / DeFi** para convertir activos sintéticos de Bitcoin en 7 redes EVM a **Bitcoin nativo (L1)**.

🔗 **Panel en vivo (GitHub Pages):** `https://robertofd31.github.io/btc-route-finder/`

## Redes y activos sintéticos soportados
- **Arbitrum One:** `WBTC`, `cbBTC`, `tBTC`, `BTC.b`
- **Ethereum:** `WBTC`, `cbBTC`, `tBTC`, `LBTC`, `kBTC`
- **Base:** `cbBTC`, `tBTC`, `LBTC`
- **Optimism:** `WBTC`, `tBTC`, `kBTC`
- **Avalanche:** `BTC.b`, `WBTC.e`
- **Polygon:** `WBTC`, `tBTC`
- **BNB Chain (BSC):** `BTCB`, `LBTC`

## Protocolos y rutas comparadas en tiempo real
1. **Garden Finance** — Atomic swaps HTLC directos (`arbitrum:wbtc`, `base:cbbtc`, `ethereum:wbtc/cbbtc`, `bnbchain:btcb`) + **ruta optimizada `Across → Base cbBTC → Garden (9 bps)`**.
2. **Threshold Network (`tBTC`)** — Redención directa 1:1 descentralizada (`0,20%` protocolo + mempool BTC) desde Arbitrum, Ethereum, Base, Optimism y Polygon.
3. **NEAR Intents (1Click)** — Red de *solvers* directos o vía USDC en las 7 redes.
4. **THORChain Streaming Swaps** — Con detección automática en vivo de pausas Mimir (`HALTBTCTRADING`, etc.).
5. **Chainflip (JIT AMM + DCA)** — Con detección automática de mantenimiento.
6. **Symbiosis Finance** — Salida directa en 1 firma EVM → Bitcoin.
7. **Lombard / Core (`BTC.b` / `LBTC`)** — Redención de tarifa fija `0.0001 BTC` sin comisión porcentual.
8. **Maya Protocol** — Con comprobación de liquidez en vivo.

## Telemetría y extras incluidos
- Precio BTC spot y prima/descuento real del activo origen (**DefiLlama**).
- Comisiones en vivo del mempool de Bitcoin (**Mempool.space**).
- Simulador de fraccionamiento en tramos con alertas de fragmentación de **UTXOs**.
- Filtros por **Mayor BTC neto**, **Más rápida**, **Menos pasos** y **0% exposición a USD**.
- Direcciones de contrato verificadas y enlaces directos a las dApps oficiales.

## Uso local
No requiere compilación ni instalación de paquetes. Sirve la carpeta con cualquier servidor estático:

```bash
python -m http.server 8080
```
y abre `http://localhost:8080`.
