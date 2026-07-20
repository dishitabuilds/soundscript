// Full-screen loading state: the speaker broadcasts expanding sound rings.
// Reused by every "Loading…" / "Starting session…" moment so they all speak
// the same visual language.

export default function Loading({ message = "Loading…" }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-page text-ink transition-colors">
      <div className="relative w-28 h-28 flex items-center justify-center">
        {/* Rings radiate outward from behind the speaker, staggered so one is
            always mid-flight. */}
        {[0, 0.8, 1.6].map((delay, i) => (
          <span
            key={i}
            className="sound-ring absolute inset-0 rounded-full border-2 border-gold"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
        <span className="text-4xl relative">🔊</span>
      </div>

      <p className="text-soft font-display text-lg tracking-wide">{message}</p>
    </div>
  );
}
