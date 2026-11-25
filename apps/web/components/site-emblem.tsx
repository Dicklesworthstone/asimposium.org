/**
 * The ASImposium mark: a kylix, the shallow two-handled cup passed around a
 * symposium. Drawn in `currentColor` so the chrome decides its tint; the
 * painted band follows the page colour through CSS (`.site-emblem .band`).
 */
export function SiteEmblem({ className = "site-emblem" }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 13.5h32c-1 7.2-7.6 11.6-16 11.6S5 20.7 4 13.5Z" />
      <path
        d="M7.2 16.2c-4.6.2-5.6-4.9-2.1-5.4M32.8 16.2c4.6.2 5.6-4.9 2.1-5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M18.5 24.8h3l-.5 5.4h-2Z" />
      <path d="M11.5 33.4c2.4-3 14.6-3 17 0-2.6 1.2-14.4 1.2-17 0Z" />
      <path
        className="band"
        d="M9 17.4h22M12.5 17.4v-1.8h2.4v1.8M18.8 17.4v-1.8h2.4v1.8M25.1 17.4v-1.8h2.4v1.8"
        fill="none"
        strokeWidth="1.1"
      />
    </svg>
  );
}
