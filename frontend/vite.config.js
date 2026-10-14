// Dev proxy: the web app calls /api and /mcp on the same origin; Vite forwards them to the local API.
// Build output goes to ../client, the folder Catalyst hosts as the web client.
export default {
  base: "./",
  build: { outDir: "../client", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
    },
  },
};
