import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api to the erebor backend (uvicorn on :8077), so the
// frontend can use same-origin /api/* URLs — including the pmtiles basemap,
// which MapLibre range-requests.
export default defineConfig({
  plugins: [react()],
  server: {
    // host:true binds to all interfaces so the dev server is reachable over the
    // Tailscale tailnet (colleagues open http://<your-tailscale-ip>:5180). The
    // /api proxy below still resolves the backend locally on this machine.
    host: true,
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8077",
        changeOrigin: true,
      },
    },
  },
});
