import nextConfig from "eslint-config-next";

const config = [{ ignores: [".next*/**", "node_modules/**", "public/pdfjs/**"] }, ...nextConfig];

export default config;
