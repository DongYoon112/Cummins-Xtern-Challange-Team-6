/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#f4f4f2",
        panel: "#ffffff",
        ink: "#1f2937",
        accent: "#0b7285",
        accentDark: "#0a4f5c",
        warn: "#b42318"
      }
    }
  },
  plugins: []
};