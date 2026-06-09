// Scenario: an RPC-only app (Soroban). The roadmap's M2 acceptance bar is that
// this bundle is < half the full-SDK bundle. If tree-shaking works, Horizon-only
// deps (eventsource, smol-toml) should NOT appear in the watch table.
export { Server } from "sdk-v16/rpc";
