import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    external: ["@prisma/client", "@prisma/adapter-mariadb"],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
