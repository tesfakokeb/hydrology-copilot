/**
 * @hydro/shared-types
 * Canonical domain types shared by the API gateway, the web client and the
 * TypeScript clients of the Python scientific services.
 *
 * These types are deliberately explicit about units, provenance and
 * uncertainty because the platform's scientific-integrity guardrails require
 * that every value carried across a service boundary is self-describing.
 */

export * from './hydrology.js';
export * from './copilot.js';
export * from './provenance.js';
export * from './api.js';
