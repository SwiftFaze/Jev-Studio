/**
 * Bring a results panel into view when a run starts. Answers now sit below the input, so on a long page they would
 * otherwise appear out of sight. Does nothing if the top of the panel is already on screen. The pinned header and
 * bottom bar are accounted for by the page's scroll-padding.
 */
export function revealPane(el) {
  const pane = el.closest('.panel') ?? el;
  const styles = getComputedStyle(document.documentElement);
  const topBar = parseFloat(styles.getPropertyValue('--topbar-h')) || 0;
  const bottomBar = parseFloat(styles.getPropertyValue('--dock-h')) || 0;
  const { top } = pane.getBoundingClientRect();
  if (top >= topBar && top < window.innerHeight - bottomBar - 120) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  pane.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
}
