/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // <--- Add this line to scan React components
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
