/** @type {import('tailwindcss').Config} */
export default {
  // Class strategy, not media: the toggle writes .dark on <html>, so the user's
  // choice wins over the OS and survives reloads via localStorage.
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // Semantic tokens, not raw hues. Components say what a surface IS
      // (page, card, input) and the light/dark values live in index.css --
      // one set of classNames covers both modes with no dark: prefixes.
      colors: {
        page: "rgb(var(--c-page) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        sunken: "rgb(var(--c-sunken) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        soft: "rgb(var(--c-soft) / <alpha-value>)",
        line: "rgb(var(--c-line) / <alpha-value>)",
        mahogany: "rgb(var(--c-mahogany) / <alpha-value>)",
        gold: {
          DEFAULT: "rgb(var(--c-gold) / <alpha-value>)",
          strong: "rgb(var(--c-gold-strong) / <alpha-value>)",
        },
        // Text color on gold buttons: dark in both modes, because polished
        // gold is a light surface wherever it appears.
        "on-gold": "rgb(var(--c-on-gold) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
        ok: "rgb(var(--c-ok) / <alpha-value>)",
      },
      fontFamily: {
        // The bookish voice of the app, without shipping a webfont.
        display: ["'Iowan Old Style'", "Palatino", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
