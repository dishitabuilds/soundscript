/** Floating day/night switch, visible on every view. */
export default function ThemeToggle({ dark, onToggle }) {
  return (
    <button
      onClick={onToggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="fixed bottom-5 right-5 z-50 w-11 h-11 rounded-full bg-surface border border-line shadow-md hover:border-gold text-lg transition flex items-center justify-center"
    >
      {dark ? "☀️" : "🌙"}
    </button>
  );
}
