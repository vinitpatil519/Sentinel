export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8010";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, "ws") + "/ws";
