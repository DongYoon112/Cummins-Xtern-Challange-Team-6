/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#f4f4f2",
        panel: "#ffffff",
        ink: "#1f2937",
        accent: "#f97316",
        accentDark: "#c2410c",
        warn: "#b42318"
      }
    }
  },
  plugins: []
};
