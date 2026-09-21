import '@testing-library/jest-dom/vitest';

/**
 * jsdom implements neither ResizeObserver nor the layout measurement Recharts
 * relies on, so charts must be given a size explicitly in tests. Stubbing both
 * keeps chart components testable for their content and behaviour; visual
 * correctness is verified by the Playwright screenshot pass instead.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
