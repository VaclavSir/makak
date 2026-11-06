// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState {
      /** The approval queue is open over the page. */
      approvals?: boolean;
    }
    // interface Platform {}
  }
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- a module, as `declare global` needs
export {};
